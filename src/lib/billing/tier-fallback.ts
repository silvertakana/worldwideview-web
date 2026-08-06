import { getStripe } from "@/lib/stripe/client";
import { getHighestTier } from "@/lib/auth/entitlements";
import { resolvePlanFromPriceId } from "@/lib/billing/constants";

export interface HubTierFallback {
  plan: string;
  status: string;
  trialEndsAt: string | null;
  isTrialing: boolean;
}

const STRIPE_STATUS_TO_HUB_STATUS: Record<string, string> = {
  active: "active",
  past_due: "past_due",
  trialing: "trialing",
  canceled: "canceled",
  unpaid: "suspended",
  incomplete: "trialing",
  incomplete_expired: "deleted",
  paused: "suspended",
};

/**
 * Hub-authoritative tier data used when the globe mirror has no org for the
 * user (tier GET 404s / globe unreachable). Stripe is the strongest proof of
 * payment: a live subscription means the user paid even if the globe-side
 * org was never provisioned. The code-redeemed entitlement table is the hub's
 * second authoritative tier store. Returns null when neither source has data,
 * in which case the billing page keeps showing the local/free plan.
 */
export async function getHubTierFallback(userId: string, email: string): Promise<HubTierFallback | null> {
  try {
    const stripe = getStripe();
    const customers = await stripe.customers.search({
      query: `metadata['userId']:'${userId}'`,
      limit: 1,
    });
    let customer = customers.data[0];
    if (!customer) {
      const byEmail = await stripe.customers.list({ email, limit: 1 });
      customer = byEmail.data[0];
    }
    if (customer && !customer.deleted) {
      const subs = await stripe.subscriptions.list({ customer: customer.id, limit: 10 });
      // Newest subscription wins when a customer has multiple live
      // subscriptions (PMT-010): sort by created desc before selecting the
      // first live-status one, so an older orphaned subscription cannot mask
      // the customer's most recent plan.
      const live = [...subs.data]
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .find((s) => ["active", "trialing", "past_due"].includes(s.status));
      if (live) {
        // Resolve the plan from the subscription's price ID (PMT-005) instead
        // of hardcoding "pro". Fall back to "pro" only when the price cannot
        // be resolved — correct today since Pro is the only sellable plan.
        const priceId = live.items?.data?.[0]?.price?.id ?? null;
        const resolved = priceId ? resolvePlanFromPriceId(priceId) : null;
        return {
          plan: resolved?.plan ?? "pro",
          status: STRIPE_STATUS_TO_HUB_STATUS[live.status] ?? live.status,
          trialEndsAt: live.trial_end ? new Date(live.trial_end * 1000).toISOString() : null,
          isTrialing: live.status === "trialing",
        };
      }
    }
  } catch (err) {
    console.error("[billing] Stripe fallback lookup failed:", err);
  }

  try {
    const tier = await getHighestTier(userId);
    if (tier === "pro" || tier === "enterprise") {
      return { plan: tier, status: "active", trialEndsAt: null, isTrialing: false };
    }
  } catch (err) {
    console.error("[billing] Entitlement fallback lookup failed:", err);
  }

  return null;
}
