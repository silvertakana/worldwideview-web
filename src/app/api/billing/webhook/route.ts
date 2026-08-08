import { NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripe/client";
import { resolvePlanFromPriceId } from "@/lib/billing/constants";
import { crossServiceFetch } from "@/lib/cross-service/fetch";
import { provisionWorkspace } from "@/lib/billing/provision";
import { claimWebhookEvent } from "@/lib/billing/webhook-idempotency";

const SUBSCRIPTION_STATUS_MAP: Record<string, string> = {
  active: "active",
  past_due: "past_due",
  unpaid: "suspended",
  canceled: "canceled",
  incomplete: "trialing",
  incomplete_expired: "canceled",
  trialing: "trialing",
  paused: "suspended",
};

interface TierSyncResult {
    ok: boolean;
    status?: number;
    detail?: string;
}

async function syncTierToGlobe(email: string, tier: string, status: string, trialEndsAt?: number | null): Promise<TierSyncResult> {
    try {
        const res = await crossServiceFetch("/api/service/tier-sync", {
            method: "POST",
            body: { email, tier, status, trialEndsAt: trialEndsAt ? new Date(trialEndsAt * 1000).toISOString() : null },
        });
        if (!res.ok) {
            const detail = (await res.text().catch(() => "")).slice(0, 160);
            return { ok: false, status: res.status, detail };
        }
        return { ok: true, status: res.status };
    } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
}

const SYNC_RETRY_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sync a tier to the globe with a single in-process retry (~500ms) on failure
 * (PMT-007). Never throws and never influences the webhook's HTTP status: a
 * permanent failure must not create a Stripe retry storm, and the paid user's
 * tier stays correct at the hub level via the tier-fallback path. The
 * attempt-2/2 failure log is the monitoring/alerting hook.
 */
async function syncTierWithRetry(
    email: string,
    tier: string,
    status: string,
    eventType: string,
    trialEndsAt?: number | null,
): Promise<TierSyncResult> {
    const label = `${tier}/${status}`;
    const first = await syncTierToGlobe(email, tier, status, trialEndsAt);
    if (first.ok) {
        console.log(`[webhook] Tier synced for ${email}: ${eventType} (${label})`);
        return first;
    }
    console.error(
        `[webhook] Tier sync FAILED for ${email}: ${eventType} (${label}) attempt 1/2 - globe returned ${first.status ?? "transport error"}${first.detail ? ` (${first.detail})` : ""}; retrying in ${SYNC_RETRY_DELAY_MS}ms`,
    );
    await sleep(SYNC_RETRY_DELAY_MS);
    const second = await syncTierToGlobe(email, tier, status, trialEndsAt);
    if (!second.ok) {
        console.error(
            `[webhook] Tier sync FAILED for ${email}: ${eventType} (${label}) attempt 2/2 - globe returned ${second.status ?? "transport error"}${second.detail ? ` (${second.detail})` : ""}. Final failure; tier remains correct at hub level via tier-fallback.`,
        );
    }
    return second;
}

interface PayloadEmailFields {
    customer_email?: string | null;
    customer_details?: { email?: string | null } | null;
    customer?: string | { email?: string | null } | null;
}

/**
 * Payload-first email resolution (PMT-009). Stripe webhook payloads already
 * carry the customer's email (customer_email top-level, customer_details.email,
 * or an expanded customer object). Prefer those before calling out to Stripe,
 * so stateless stripe-mock / the offline webhook simulator can drive tier-sync
 * assertions. `customer` is usually a string ID — only an object carries an
 * inline email. Returns null when the payload has no email; callers keep the
 * outbound retrieve fallback.
 */
function emailFromPayload(obj: PayloadEmailFields): string | null {
    if (obj.customer_email) return obj.customer_email;
    if (obj.customer_details?.email) return obj.customer_details.email;
    if (typeof obj.customer === "object" && obj.customer !== null && obj.customer.email) {
        return obj.customer.email;
    }
    return null;
}

/**
 * Outbound fallback for email resolution: retrieve the customer and read their
 * email. Deleted customers have no email. Never throws — a retrieve failure
 * logs and returns null so the handler proceeds without syncing.
 */
async function resolveCustomerEmail(stripe: Stripe, customerId: string): Promise<string | null> {
    try {
        const customer = await stripe.customers.retrieve(customerId);
        return !customer.deleted ? (customer as any).email : null;
    } catch (err) {
        console.warn(
            `[webhook] Could not retrieve customer ${customerId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
    }
}

export async function POST(req: Request) {
  const stripe = getStripe();
  const body = await req.text();
  const sig = req.headers.get("stripe-signature");

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig!,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch (err: any) {
    return new NextResponse(`Webhook Error: ${err.message}`, { status: 400 });
  }

  // PMT-008: claim the event before processing. The unique event_id makes
  // duplicate deliveries (Stripe retries, dashboard replay) a no-op — a
  // duplicate returns 200 without re-processing or re-calling the globe.
  // Fail-open: if the idempotency store is unavailable ("unknown"), we process
  // anyway rather than drop the event.
  const idempotency = await claimWebhookEvent(event.id);
  if (idempotency === "duplicate") {
    console.log(`[webhook] Duplicate event ${event.id} (${event.type}) already processed; skipping`);
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        // Expand the subscription object and its line-item prices so the
        // plan can be resolved from `items.data[0].price.id` below.
        // ("subscription.data.default_price" was an invalid expand path:
        // `subscription` is an object, not a list, and Subscription has no
        // `default_price` field.)
        const session = await stripe.checkout.sessions.retrieve(
          (event.data.object as { id: string }).id,
          { expand: ["subscription", "subscription.items.data.price"] },
        );

        // Payload-first email (PMT-009): the checkout payload carries the
        // email itself — no outbound call needed for it. metadata.email stays
        // as a hub-specific fallback, then an outbound customer retrieve.
        const payload = event.data.object as PayloadEmailFields;
        const email =
          emailFromPayload(payload) ||
          (payload as any).metadata?.email ||
          (typeof payload.customer === "string"
            ? await resolveCustomerEmail(stripe, payload.customer)
            : null);
        if (!email) {
          console.warn("[webhook] checkout.session.completed missing email");
          break;
        }

        const sub = session.subscription as { trial_end?: number | null } | null;
        const trialEndsAt = sub?.trial_end ?? Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

        const stripeSub = session.subscription as {
          items?: { data?: Array<{ price: { id: string } }> };
        } | null;
        const priceId = stripeSub?.items?.data?.[0]?.price?.id ?? null;
        const resolved = priceId ? resolvePlanFromPriceId(priceId) : null;
        const plan = resolved?.plan ?? "pro";

        // PMT-001: provision the user's globe workspace BEFORE syncing the
        // tier. A newly paying user has no globe org yet, so a tier sync first
        // would 404 ("Organization not found") and leave the org, once
        // provisioned, at free tier — the user would see "Free / Upgrade to
        // Pro" despite an active subscription. Provisioning first guarantees
        // the tier sync finds the org. Best-effort: a provisioning failure
        // must never fail the webhook (Stripe would retry); the tier sync is
        // still attempted so the honest-failure path (404 without an org)
        // logs as today. The globe endpoint is idempotent, so duplicate
        // checkout deliveries are safe ("already exists" returns ok).
        const hubUserId = session.metadata?.userId || session.client_reference_id || "";
        if (!hubUserId) {
          // LOUD skip (PMT-017): a missing hubUserId means Stripe metadata never
          // linked this checkout to a hub account — the user paid but nothing
          // will be provisioned on the globe. Error-level, with every
          // identifying field in scope so an operator can find and remediate
          // the affected account from the log alone.
          console.error(
            `[webhook] checkout.session.completed: SKIPPED workspace provisioning - no hubUserId on checkout session; account requires manual remediation. sessionId=${session.id} email=${email} customerId=${session.customer ?? "n/a"} eventId=${event.id}`,
          );
        } else {
          const provision = await provisionWorkspace({
            email,
            hubUserId,
            name: session.customer_details?.name || undefined,
            subdomain: session.metadata?.subdomain || undefined,
          });
          if (provision.ok) {
            console.log(`[webhook] Workspace provisioned for ${email}`);
          } else {
            console.error(
              `[webhook] Workspace provisioning FAILED for ${email} - globe returned ${provision.status ?? "transport error"}${provision.detail ? ` (${provision.detail})` : ""}`,
            );
          }
        }

        await syncTierWithRetry(email, plan, "trialing", event.type, trialEndsAt);
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const subscription = event.data.object as {
          id: string;
          status: string;
          customer?: string;
          customer_email?: string | null;
          items?: { data?: Array<{ price: { id: string } }> };
        };

        const status = SUBSCRIPTION_STATUS_MAP[subscription.status] || "suspended";
        const priceId = subscription.items?.data?.[0]?.price?.id;
        const resolved = priceId ? resolvePlanFromPriceId(priceId) : null;
        // PMT-013: when a trial ends unpaid (incomplete_expired -> "canceled")
        // or the subscription is canceled, the user is no longer entitled to
        // the plan the price ID resolves to. Sync free so the globe never sees
        // pro/canceled (which would leave the workspace at the paid tier
        // instead of locking it). "deleted" is never emitted: the status map
        // maps incomplete_expired to "canceled" and the subscription.deleted
        // handler syncs "free/canceled" directly; the globe rejects "deleted".
        const plan = status === "canceled" || status === "deleted" ? "free" : resolved?.plan ?? "pro";

        // Payload-first email (PMT-009); subscriptions rarely carry one, so the
        // outbound customer retrieve remains the primary path here.
        const email =
          emailFromPayload(subscription) ||
          (typeof subscription.customer === "string"
            ? await resolveCustomerEmail(stripe, subscription.customer)
            : null);

        if (email) {
          await syncTierWithRetry(email, plan, status, event.type);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const deletedSub = event.data.object as { customer?: string; customer_email?: string | null };

        const email =
          emailFromPayload(deletedSub) ||
          (typeof deletedSub.customer === "string"
            ? await resolveCustomerEmail(stripe, deletedSub.customer)
            : null);

        if (email) {
          await syncTierWithRetry(email, "free", "canceled", event.type);
        }
        break;
      }

      case "invoice.payment_failed": {
        const failedInvoice = event.data.object as unknown as {
          customer: string;
          subscription: string;
          customer_email?: string | null;
          customer_details?: { email?: string | null } | null;
        };

        // Payload-first email (PMT-009): invoices carry customer_email, so the
        // offline stack can assert tier-sync without an outbound retrieve.
        const email =
          emailFromPayload(failedInvoice) ||
          (await resolveCustomerEmail(stripe, failedInvoice.customer));

        if (email) {
          // PMT-002: resolve the tier from the subscription's price ID instead
          // of sending an empty string — the globe's tier-sync rejects an
          // empty tier with 400. Fall back to "pro": a failed payment is by
          // definition an attempt at a Pro subscription today.
          let plan = "pro";
          try {
            const sub = (await stripe.subscriptions.retrieve(failedInvoice.subscription, {
              expand: ["items.data.price"],
            })) as unknown as { items?: { data?: Array<{ price: { id: string } }> } };
            const priceId = sub.items?.data?.[0]?.price?.id;
            const resolved = priceId ? resolvePlanFromPriceId(priceId) : null;
            plan = resolved?.plan ?? "pro";
          } catch (err) {
            console.warn(
              `[webhook] invoice.payment_failed could not resolve plan for ${email}; defaulting to pro: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          await syncTierWithRetry(email, plan, "past_due", event.type);
        }
        break;
      }
    }
  } catch (err: any) {
    console.error(`[webhook] Error handling ${event.type}:`, err);
  }

  return NextResponse.json({ received: true });
}
