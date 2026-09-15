import { getHighestTier } from "@/lib/auth/entitlements";
import { getHubTierFallback } from "@/lib/billing/tier-fallback";
import { getActiveOverride } from "@/lib/billing/subscription-store";

/* eslint-disable security/detect-object-injection -- every index is a literal
   TierSource key or a lookup of an internal tier string in TIER_RANK. */

/**
 * Canonical tier ranking for the hub. The hub is the billing authority, so this
 * is the map the durable record compares tiers with.
 *
 * It deliberately does not match either map already in the tree, because those
 * two disagree with each other:
 *
 *   hub   src/lib/auth/entitlements.ts:32-34   free 0, beta_tester 1,
 *         early_access 2, pro 3, enterprise 4   -- NO "team" key
 *   globe src/lib/org-tier.ts:15-23 (origin/main)   free 0, canceled 0,
 *         beta_tester 1, early_access 2, pro 3, team 4, enterprise 5
 *
 * `team` is purchasable on the hub (src/lib/billing/constants.ts:36-38 maps plan
 * "team" to the team price env keys), so a hub map that cannot represent it is a
 * defect: getHighestTier() scores a team entitlement as 0 through its `?? 0`
 * fallback, which is the same score as free. Ranking team between pro and
 * enterprise matches the globe's relative order. "canceled" ranks 0 to match the
 * globe's effectiveTierForLock treatment, and so does any unknown tier, so a bad
 * tier string can never outrank a real one.
 *
 * CONVERGENCE: with team inserted between pro and enterprise, this map is the
 * globe's origin/main order (src/lib/org-tier.ts:15-23 via
 * src/app/api/instance/[id]/tier/route.ts) with the same enterprise:5 ceiling,
 * so the two services agree on relative rank. The hub's own map in
 * src/lib/auth/entitlements.ts:32-34 is the one that still has to change, and it
 * is a live read path, so it is deliberately NOT edited on this branch.
 */
export const TIER_RANK: Record<string, number> = {
  free: 0,
  canceled: 0,
  beta_tester: 1,
  early_access: 2,
  pro: 3,
  team: 4,
  enterprise: 5,
};

export function tierRank(tier: string | null | undefined): number {
  if (!tier) return 0;
  return TIER_RANK[tier] ?? 0;
}

export type TierSource = "stripe" | "entitlement" | "override";

export interface TierResolution {
  tier: string;
  /** Which source produced `tier`. */
  source: TierSource;
  /** What each source contributed; null means that source found nothing. */
  tiers: Record<TierSource, string | null>;
  /** Present for each source that threw. A resolution is still returned. */
  errors: Partial<Record<TierSource, string>>;
}

/** Tie order: earlier wins. A deliberate operator override outranks a tie. */
const RESOLUTION_ORDER: TierSource[] = ["override", "stripe", "entitlement"];

/**
 * The hub tier for a user, resolved from THREE independent sources:
 *
 *   1. `stripe`      - live Stripe derivation (getHubTierFallback). Null means
 *                      Stripe claims nothing for this user.
 *   2. `entitlement` - code-redemption tiers (getHighestTier).
 *   3. `override`    - an active operator override (getActiveOverride).
 *
 * Every source is attempted. A source that throws is recorded in `errors` and
 * simply does not compete, so one broken source can never hide another source's
 * paid tier. The highest-ranked tier wins. With no data anywhere the result is
 * "free".
 *
 * NOTE: this reads the operator override through subscription-store.ts, so
 * records.ts and subscription-store.ts must not import this module - the
 * dependency runs one way on purpose.
 */
export async function resolveEffectiveHubTier(userId: string, email: string): Promise<TierResolution> {
  const errors: Partial<Record<TierSource, string>> = {};
  const tiers: Record<TierSource, string | null> = { stripe: null, entitlement: null, override: null };

  const attempts: Array<{ source: TierSource; run: () => Promise<string | null> }> = [
    { source: "stripe", run: async () => (await getHubTierFallback(userId, email))?.plan ?? null },
    { source: "entitlement", run: async () => await getHighestTier(userId) },
    { source: "override", run: async () => (await getActiveOverride(userId))?.tier ?? null },
  ];

  for (const { source, run } of attempts) {
    try {
      tiers[source] = await run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors[source] = message;
      console.error(`[billing] ${source} tier source failed for ${userId}: ${message}`);
    }
  }

  let winner: TierSource | null = null;
  for (const source of RESOLUTION_ORDER) {
    const value = tiers[source];
    if (value === null) continue;
    if (winner === null || tierRank(value) > tierRank(tiers[winner])) winner = source;
  }

  return {
    tier: winner === null ? "free" : (tiers[winner] ?? "free"),
    source: winner ?? "stripe",
    tiers,
    errors,
  };
}
