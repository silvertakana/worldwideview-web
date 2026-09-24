import type { GlobeTier } from "@/lib/billing/globe-tiers";

/**
 * The tiers an access code may GRANT.
 *
 * A code's only job is to give somebody cloud access, and access lives on the
 * GLOBE: redeeming a code mirrors the tier onto the globe's tier-sync endpoint
 * (src/app/accounts/redeem/actions.ts), and that endpoint accepts exactly
 * free/pro/team/enterprise (GLOBE_TIERS). A code carrying any other tier
 * therefore redeems into a DEAD GRANT - the hub records an entitlement, the
 * globe rejects the push, and the customer who paid attention and redeemed a
 * working code has nothing. The admin form offered two such tiers
 * (`beta_tester`, `early_access`) and the validator accepted them.
 *
 * MAPPING THEM ONTO "pro" WAS THE ALTERNATIVE, AND IS REJECTED. Both tiers rank
 * BELOW pro (src/lib/billing/tier-rank.ts), so a mapping would have the globe
 * report a tier strictly higher than the one the hub believes the customer
 * holds - the two services disagreeing about the same customer, which is the
 * failure mode the whole cross-service design exists to avoid.
 * src/lib/billing/globe-tiers.ts already says so in its own words: mapping a
 * hub-only tier onto a globe tier would be "a silent lie". Restricted instead.
 *
 * WHY ONLY pro AND enterprise, when the globe also accepts team. This is the
 * intersection of what the code path already offered and what the globe accepts,
 * which is the smallest change that removes every dead grant. Adding `team` would
 * mean an operator could mint, for the first time, an entitlement tier the codes
 * path has never produced - a new capability riding along inside a launch-safety
 * fix. That is a deliberate product decision, not this one.
 *
 * `satisfies` (not a bare annotation) keeps the literal types AND proves at
 * compile time that every member is a tier the globe accepts; code-tiers.test.ts
 * pins the list against GLOBE_TIERS so it cannot quietly drift.
 *
 * Dependency-free, like globe-tiers.ts, because the admin client components
 * import it.
 */
export const CODE_TIERS = ["pro", "enterprise"] as const satisfies readonly GlobeTier[];

export type CodeTier = (typeof CODE_TIERS)[number];

/** What a code grants when the operator does not choose. Pro is the sellable plan. */
export const DEFAULT_CODE_TIER: CodeTier = CODE_TIERS[0];

export function isCodeTier(value: string): value is CodeTier {
  return (CODE_TIERS as readonly string[]).includes(value);
}

/** Sentence-shaped, for a form hint or a validation error. */
export const CODE_TIERS_HELP = `Tier must be one of: ${CODE_TIERS.join(", ")}.`;

/** "pro" -> "Pro". Stored lowercase, shown title-cased on every admin screen. */
export function codeTierLabel(tier: string): string {
  return tier.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
