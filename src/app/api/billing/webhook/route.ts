import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe/client";
import { resolvePlanFromPriceId } from "@/lib/billing/constants";
import { crossServiceFetch } from "@/lib/cross-service/fetch";

const SUBSCRIPTION_STATUS_MAP: Record<string, string> = {
  active: "active",
  past_due: "past_due",
  unpaid: "suspended",
  canceled: "canceled",
  incomplete: "trialing",
  incomplete_expired: "deleted",
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

function logTierSync(email: string, label: string, result: TierSyncResult): void {
    if (result.ok) {
        console.log(`[webhook] Tier synced for ${email}: ${label}`);
    } else {
        console.error(
            `[webhook] Tier sync FAILED for ${email}: ${label} - globe returned ${result.status ?? "transport error"}${result.detail ? ` (${result.detail})` : ""}`,
        );
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

        const email = session.customer_details?.email || session.metadata?.email;
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

        const sync = await syncTierToGlobe(email, plan, "trialing", trialEndsAt);
        logTierSync(email, `${plan}/trialing`, sync);
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const subscription = event.data.object as {
          id: string;
          status: string;
          customer?: string;
          items?: { data?: Array<{ price: { id: string } }> };
        };

        const status = SUBSCRIPTION_STATUS_MAP[subscription.status] || "suspended";
        const priceId = subscription.items?.data?.[0]?.price?.id;
        const resolved = priceId ? resolvePlanFromPriceId(priceId) : null;
        const plan = resolved?.plan ?? "pro";

        const customerId = subscription.customer as string;
        const customer = await stripe.customers.retrieve(customerId);
        const email = !customer.deleted ? (customer as any).email : null;

        if (email) {
          const sync = await syncTierToGlobe(email, plan, status);
          logTierSync(email, `${plan}/${status}`, sync);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const deletedSub = event.data.object as { customer?: string };
        const customerId = deletedSub.customer as string;
        const customer = await stripe.customers.retrieve(customerId);
        const email = !customer.deleted ? (customer as any).email : null;

        if (email) {
          const sync = await syncTierToGlobe(email, "free", "canceled");
          logTierSync(email, "free/canceled", sync);
        }
        break;
      }

      case "invoice.payment_failed": {
        const failedInvoice = event.data.object as unknown as { customer: string; subscription: string };
        const cust = await stripe.customers.retrieve(failedInvoice.customer);
        const email = !cust.deleted ? (cust as any).email : null;

        if (email) {
          const sync = await syncTierToGlobe(email, "", "past_due");
          logTierSync(email, "past_due", sync);
        }
        break;
      }
    }
  } catch (err: any) {
    console.error(`[webhook] Error handling ${event.type}:`, err);
  }

  return NextResponse.json({ received: true });
}
