import { NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripe/client";
import { resolvePlanFromPriceId } from "@/lib/billing/constants";
import { crossServiceFetch } from "@/lib/cross-service/fetch";
import { provisionWorkspace } from "@/lib/billing/provision";
import { firstVerifiedHubUserId } from "@/lib/billing/hub-user";
import {
  epochSecondsToIso,
  intervalOf,
  priceIdOf,
  writeSubscriptionRecord,
  type StripeSubscriptionLike,
} from "@/lib/billing/webhook-record";
import {
  claimWebhookEvent,
  completeWebhookEvent,
  failWebhookEvent,
} from "@/lib/billing/webhook-idempotency";

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
    metadata?: { email?: string | null; userId?: string | null } | null;
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

interface CustomerContext {
    email: string | null;
    userId: string | null;
}

/**
 * Outbound fallback when the payload carries no email: retrieve the customer and
 * read BOTH facts this route wants off that one object — the email and the
 * `metadata.userId` candidate the hub writes when it creates the customer
 * (checkout/route.ts:90). One retrieve serves both, so resolving the hub user id
 * costs no extra API call. Deleted customers have neither. Never throws — a
 * retrieve failure logs and yields two nulls so the handler proceeds without
 * syncing.
 */
async function resolveCustomerContext(stripe: Stripe, customerId: string): Promise<CustomerContext> {
    try {
        const customer = await stripe.customers.retrieve(customerId);
        if (customer.deleted) return { email: null, userId: null };
        return { email: customer.email, userId: customer.metadata?.userId ?? null };
    } catch (err) {
        console.warn(
            `[webhook] Could not retrieve customer ${customerId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { email: null, userId: null };
    }
}

interface ResolvedIdentity {
    email: string;
    userId: string | null;
    customerId: string | null;
}

/**
 * Who this event is about: an email, and a hub user id that has been PROVEN to
 * exist (see hub-user.ts — `metadata.userId` is written by the hub and by the
 * marketplace, so an unvalidated candidate may be a Prisma cuid).
 *
 * Returns null when no email can be found: email is the record's identity
 * (UNIQUE(email)) and the tier sync's key, so without it there is nothing to
 * record and nothing to sync.
 */
async function resolveIdentity(
    stripe: Stripe,
    payload: PayloadEmailFields,
    hubUserIdCandidates: Array<string | null | undefined>,
): Promise<ResolvedIdentity | null> {
    const payloadEmail = emailFromPayload(payload) || payload.metadata?.email || null;
    const customerId = typeof payload.customer === "string" ? payload.customer : null;
    const outbound = payloadEmail === null && customerId ? await resolveCustomerContext(stripe, customerId) : null;

    const email = payloadEmail ?? outbound?.email ?? null;
    if (!email) return null;

    return {
        email,
        userId: await firstVerifiedHubUserId([...hubUserIdCandidates, outbound?.userId]),
        customerId,
    };
}

interface SubscriptionEventFacts {
    eventId: string;
    eventType: string;
    eventCreated: number | null;
    email: string;
    userId: string | null;
    customerId: string | null;
    subscription: StripeSubscriptionLike | null;
    plan: string;
    status: string;
    stripeStatus: string | null;
    /** Epoch seconds for the globe payload; the checkout path fabricates a trial end when Stripe has none. */
    trialEndsAt: number | null;
}

/**
 * The durable record, then the tier push — in that order, so the hub's own
 * memory of "this customer has this subscription" exists even if the globe call
 * dies. Neither step can change the HTTP status returned to Stripe.
 *
 * Every Stripe-derived column is read from `facts.subscription` and NOT from the
 * derived `plan`/`status`/`trialEndsAt` above: those carry the checkout path's
 * fabricated trial fallback and the plan/status mapping this route applies, and
 * the ledger must hold what Stripe actually says (with `stripe_status` as the raw
 * value) or a later reconciliation reads drift that is not there.
 *
 * A null subscription means the event did not give us the object (the invoice
 * path's retrieve failed, or a non-subscription checkout): there is nothing
 * truthful to record, and writing a guessed plan over an existing row is worse
 * than writing nothing, so the ledger is skipped and said so.
 */
async function applySubscriptionEvent(facts: SubscriptionEventFacts): Promise<void> {
    if (facts.subscription === null) {
        console.warn(
            `[webhook] No subscription object on ${facts.eventType} (${facts.eventId}) for ${facts.email}; durable record left untouched`,
        );
    } else {
        const priceId = priceIdOf(facts.subscription);
        const resolved = priceId ? resolvePlanFromPriceId(priceId) : null;
        await writeSubscriptionRecord({
            user_id: facts.userId,
            email: facts.email,
            stripe_customer_id: facts.customerId,
            stripe_subscription_id: facts.subscription.id,
            price_id: priceId,
            plan: facts.plan,
            interval: intervalOf(facts.subscription) ?? resolved?.interval ?? null,
            status: facts.status,
            stripe_status: facts.stripeStatus,
            current_period_end: epochSecondsToIso(facts.subscription.current_period_end),
            trial_ends_at: epochSecondsToIso(facts.subscription.trial_end),
            cancel_at_period_end: facts.subscription.cancel_at_period_end ?? false,
            eventCreated: facts.eventCreated,
        });
    }

    await syncTierWithRetry(facts.email, facts.plan, facts.status, facts.eventType, facts.trialEndsAt);
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new NextResponse(`Webhook Error: ${message}`, { status: 400 });
  }

  // PMT-008 / D1: claim the event before processing. A claim row on its own only
  // means an attempt started; it short-circuits a redelivery once processed_at is
  // set, i.e. once the work actually completed. Previously the claim alone was
  // treated as "done", so any mid-handler failure left the event claimed forever:
  // Stripe was told 200, never retried, and every replay was absorbed as a
  // duplicate — a silently lost payment.
  // Fail-open: if the idempotency store is unavailable ("unknown"), we process
  // anyway rather than drop the event.
  const idempotency = await claimWebhookEvent(event.id);
  if (idempotency === "completed") {
    // Deliberately names the state rather than saying "already processed": a
    // claim row on its own means an attempt started, and only a non-null
    // processed_at means the work finished. Conflating the two is the slip D1
    // came from, and this line is the one a person reads when a payment looks
    // like it was swallowed.
    console.log(
      `[webhook] Duplicate event ${event.id} (${event.type}) already completed (processed_at set); skipping`,
    );
    return NextResponse.json({ received: true, duplicate: true });
  }

  const eventCreated = event.created ?? null;

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
        //
        // The hub user id comes from the hub's own metadata first
        // (checkout/route.ts sets session metadata and client_reference_id to the
        // Supabase uid), then from the Stripe customer object if the retrieve
        // above had to happen anyway.
        const payload = event.data.object as PayloadEmailFields;
        const identity = await resolveIdentity(stripe, payload, [
          session.metadata?.userId,
          session.client_reference_id,
        ]);
        if (!identity) {
          console.warn("[webhook] checkout.session.completed missing email");
          break;
        }
        const { email, userId } = identity;

        const subscription = session.subscription as StripeSubscriptionLike | null;
        const trialEndsAt = subscription?.trial_end ?? Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

        const priceId = priceIdOf(subscription);
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

        await applySubscriptionEvent({
          eventId: event.id,
          eventType: event.type,
          eventCreated,
          email,
          userId,
          customerId: typeof session.customer === "string" ? session.customer : identity.customerId,
          subscription,
          plan,
          status: "trialing",
          stripeStatus: subscription?.status ?? null,
          trialEndsAt,
        });
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const subscription = event.data.object as unknown as StripeSubscriptionLike & { status: string };

        const status = SUBSCRIPTION_STATUS_MAP[subscription.status] || "suspended";
        const priceId = priceIdOf(subscription);
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
        const identity = await resolveIdentity(stripe, subscription, [subscription.metadata?.userId]);
        if (identity) {
          await applySubscriptionEvent({
            eventId: event.id,
            eventType: event.type,
            eventCreated,
            email: identity.email,
            userId: identity.userId,
            customerId: identity.customerId,
            subscription,
            plan,
            status,
            stripeStatus: subscription.status,
            // `trial_end` is carried through so the globe keeps seeing an
            // expired trial as an expired trial rather than as "no trial".
            trialEndsAt: subscription.trial_end ?? null,
          });
        }
        break;
      }

      case "customer.subscription.deleted": {
        const deletedSub = event.data.object as unknown as StripeSubscriptionLike;

        const identity = await resolveIdentity(stripe, deletedSub, [deletedSub.metadata?.userId]);
        if (identity) {
          await applySubscriptionEvent({
            eventId: event.id,
            eventType: event.type,
            eventCreated,
            email: identity.email,
            userId: identity.userId,
            customerId: identity.customerId,
            subscription: deletedSub,
            plan: "free",
            status: "canceled",
            stripeStatus: deletedSub.status ?? "canceled",
            trialEndsAt: deletedSub.trial_end ?? null,
          });
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
        const identity = await resolveIdentity(stripe, failedInvoice, []);
        if (!identity) break;

        // PMT-002: resolve the tier from the subscription's price ID instead
        // of sending an empty string — the globe's tier-sync rejects an
        // empty tier with 400. Fall back to "pro": a failed payment is by
        // definition an attempt at a Pro subscription today.
        let plan = "pro";
        let subscription: StripeSubscriptionLike | null = null;
        try {
          subscription = (await stripe.subscriptions.retrieve(failedInvoice.subscription, {
            expand: ["items.data.price"],
          })) as unknown as StripeSubscriptionLike;
          const priceId = priceIdOf(subscription);
          const resolved = priceId ? resolvePlanFromPriceId(priceId) : null;
          plan = resolved?.plan ?? "pro";
        } catch (err) {
          console.warn(
            `[webhook] invoice.payment_failed could not resolve plan for ${identity.email}; defaulting to pro: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        await applySubscriptionEvent({
          eventId: event.id,
          eventType: event.type,
          eventCreated,
          email: identity.email,
          // The subscription retrieve above is the only thing that can name the
          // hub user on this path, and its metadata is the hub's own.
          userId: await firstVerifiedHubUserId([subscription?.metadata?.userId]),
          customerId: identity.customerId ?? failedInvoice.customer ?? null,
          subscription,
          plan,
          status: "past_due",
          stripeStatus: subscription?.status ?? null,
          trialEndsAt: null,
        });
        break;
      }
    }
  } catch (err) {
    // D1: a handler failure must never be reported as delivered. Swallowing it
    // into a 200 told Stripe the event was handled, so Stripe never retried and
    // the only trace of a lost payment was this log line.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[webhook] Handling FAILED for ${event.id} (${event.type}); answering 500 so Stripe redelivers:`,
      err,
    );
    await failWebhookEvent(event.id, message);
    return NextResponse.json(
      { received: false, error: "Webhook handling failed" },
      { status: 500 },
    );
  }

  // Reached only when the switch ran to completion: mark the event finished so a
  // later redelivery short-circuits instead of reprocessing.
  await completeWebhookEvent(event.id);
  return NextResponse.json({ received: true });
}
