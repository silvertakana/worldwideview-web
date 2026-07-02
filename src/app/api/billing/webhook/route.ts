import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe/client";
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

async function syncTierToGlobe(email: string, tier: string, status: string, trialEndsAt?: number | null) {
  try {
    await crossServiceFetch("/api/service/tier-sync", {
      method: "POST",
      body: { email, tier, status, trialEndsAt: trialEndsAt ? new Date(trialEndsAt * 1000).toISOString() : null },
    });
  } catch (err) {
    console.error("[webhook] Failed to sync tier to globe:", err);
  }
}

export async function POST(req: Request) {
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
        const session = await stripe.checkout.sessions.retrieve(
          (event.data.object as { id: string }).id,
          { expand: ["subscription", "subscription.data.default_price"] },
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

        await syncTierToGlobe(email, plan, "trialing", trialEndsAt);
        console.log(`[webhook] Tier synced for ${email}: ${plan}/trialing`);
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
          await syncTierToGlobe(email, plan, status);
          console.log(`[webhook] Tier synced for ${email}: ${plan}/${status}`);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const deletedSub = event.data.object as { customer?: string };
        const customerId = deletedSub.customer as string;
        const customer = await stripe.customers.retrieve(customerId);
        const email = !customer.deleted ? (customer as any).email : null;

        if (email) {
          await syncTierToGlobe(email, "free", "canceled");
          console.log(`[webhook] Tier synced for ${email}: free/canceled`);
        }
        break;
      }

      case "invoice.payment_failed": {
        const failedInvoice = event.data.object as unknown as { customer: string; subscription: string };
        const cust = await stripe.customers.retrieve(failedInvoice.customer);
        const email = !cust.deleted ? (cust as any).email : null;

        if (email) {
          await syncTierToGlobe(email, "", "past_due");
          console.log(`[webhook] Tier synced for ${email}: past_due`);
        }
        break;
      }
    }
  } catch (err: any) {
    console.error(`[webhook] Error handling ${event.type}:`, err);
  }

  return NextResponse.json({ received: true });
}
