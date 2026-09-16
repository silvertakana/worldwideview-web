/**
 * The globe's tier vocabulary and the result shapes of a globe call.
 *
 * This module is deliberately dependency-free: the operator screen's client
 * components import GLOBE_TIERS from here, and anything that reaches this file
 * would otherwise drag the HMAC signer (`node:crypto`) into the browser bundle
 * and break the production build. The fetchers live in globe-sync.ts.
 */

/**
 * The tier vocabulary the globe's POST /api/service/tier-sync accepts.
 *
 * Verified against `worldwideview` origin/main
 * `src/app/api/service/tier-sync/route.ts`: the accepted set is exactly
 * free/pro/team/enterprise. `beta_tester` and `early_access` are ranked by the
 * globe's TIER_RANK but the endpoint does NOT accept them, so they are absent
 * on purpose. Mapping one of those to something else would be a silent lie.
 */
export const GLOBE_TIERS = ["free", "pro", "team", "enterprise"] as const;

export type GlobeTier = (typeof GLOBE_TIERS)[number];

export function isGlobeTier(value: string): value is GlobeTier {
  return (GLOBE_TIERS as readonly string[]).includes(value);
}

/**
 * Why a globe call did not land. The three cases need three different operator
 * responses - "this customer has no globe workspace", "the globe refused what we
 * sent", "we could not talk to the globe" - so they are never collapsed into one
 * generic failure.
 */
export type GlobeFailure = "no-organization" | "rejected" | "unreachable";

export type GlobePushResult =
  | { ok: true; detail: string }
  | { ok: false; failure: GlobeFailure; detail: string };

export interface GlobeTierState {
  tier: string;
  status: string;
  effectiveTier: string;
  effectiveStatus: string;
  instanceCount: number;
}

export type GlobeReadResult =
  | { ok: true; state: GlobeTierState }
  | { ok: false; failure: "no-organization" | "unreachable"; detail: string };
