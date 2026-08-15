import type { HubTierFallback } from "@/lib/billing/tier-fallback";

/**
 * Billing-page tier resolution between the two authorities:
 *
 * - The HUB is the billing authority (ADR-0009 / cloud-orchestrator-hub design):
 *   Stripe subscriptions are the strongest proof of payment, and the code-
 *   redeemed `user_entitlements` table is the hub's second store.
 * - The GLOBE's `org_tiers` cache is a MIRROR that fails open to "free" when
 *   the row is missing or stale (the tier-sync 404 / provisioning gap). A
 *   globe "free" is therefore INCONCLUSIVE — it cannot prove non-payment.
 *
 * Resolution semantics: a globe PAID tier is conclusive and wins outright (the
 * mirror is authoritative for paid). A globe "free"/"local", or a failed globe
 * fetch, is inconclusive: the hub authority decides when it resolves to a paid
 * tier, and the page fails safe to the Free plan when neither authority claims
 * a paid tier.
 */

export interface GlobeTierSnapshot {
  /** Whether the globe `/api/service/tier` fetch succeeded with a 2xx. */
  succeeded: boolean;
  /** Globe response `plan` field (rarely set; the globe returns `tier`). */
  plan?: string | null;
  /** Globe response `tier` field ("free" | "pro" | "team" | "enterprise"). */
  tier?: string | null;
  status?: string | null;
  trialEndsAt?: string | null;
  isTrialing?: boolean;
}

export interface DisplayTierDecision {
  plan: string;
  status: string;
  trialEndsAt: string | null;
  isTrialing: boolean;
  /** Which authority produced the plan: "globe", "hub", or "local" (no paid tier claimed). */
  source: "globe" | "hub" | "local";
}

/** Plans that mean "no paid tier". "local" is the page's internal free label. */
const INCONCLUSIVE_PLANS = new Set(["local", "free"]);

function effectiveGlobePlan(globe: GlobeTierSnapshot): string {
  return globe.plan || (globe.tier && globe.tier !== "free" ? globe.tier : "local");
}

export function isPaidPlan(plan: string): boolean {
  return plan !== "" && !INCONCLUSIVE_PLANS.has(plan);
}

/**
 * True when the globe result cannot prove a paid tier (fetch failed, or it
 * reported "free"/"local"), so the hub authority must be consulted. False when
 * the globe reports a paid tier — the mirror is authoritative for paid.
 */
export function shouldConsultHubAuthority(globe: GlobeTierSnapshot): boolean {
  if (!globe.succeeded) return true;
  return !isPaidPlan(effectiveGlobePlan(globe));
}

/**
 * Effective display tier for the billing page. A globe PAID tier wins; a globe
 * free/local (or globe failure) defers to the hub fallback when it resolves to
 * a paid tier, and otherwise falls safe to the Free plan ("local").
 */
export function resolveDisplayTier(
  globe: GlobeTierSnapshot,
  hub: HubTierFallback | null,
): DisplayTierDecision {
  if (globe.succeeded && isPaidPlan(effectiveGlobePlan(globe))) {
    return {
      plan: effectiveGlobePlan(globe),
      status: globe.status ?? "not_found",
      trialEndsAt: globe.trialEndsAt ?? null,
      isTrialing: globe.isTrialing ?? false,
      source: "globe",
    };
  }

  if (hub) {
    return {
      plan: hub.plan,
      status: hub.status,
      trialEndsAt: hub.trialEndsAt,
      isTrialing: hub.isTrialing,
      source: "hub",
    };
  }

  return {
    plan: "local",
    status: globe.succeeded ? globe.status ?? "not_found" : "not_found",
    trialEndsAt: globe.trialEndsAt ?? null,
    isTrialing: globe.isTrialing ?? false,
    source: "local",
  };
}
