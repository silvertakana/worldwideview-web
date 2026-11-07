/**
 * The shapes of the globe's usage read.
 *
 * Dependency-free on purpose, like globe-tiers.ts: anything that imports this
 * from a client component must not drag the HMAC signer (node:crypto) into the
 * browser bundle. The fetcher that produces these lives in globe-sync.ts.
 */

/** The UTC window a usage number belongs to. */
export interface GlobeUsagePeriod {
  /** ISO instant, first moment of the UTC month. */
  start: string;
  /** ISO instant, first moment of the next UTC month -- exclusive. */
  end: string;
  /** "2026-11". */
  label: string;
}

/** One tool's share of a key's month. */
export interface GlobeToolUsage {
  toolName: string;
  calls: number;
  /** ISO instant of the most recent counted call, when the globe reported one. */
  lastCallAt: string | null;
}

/** One key's month. */
export interface GlobeKeyUsage {
  keyId: string;
  /** Owner at call time. Null only for a row whose key has been deleted. */
  userId: string | null;
  /** The key's label, null when the key has been deleted since the call. */
  name: string | null;
  /** The prefix half of the bearer token, null for a deleted key. */
  prefix: string | null;
  calls: number;
  tools: GlobeToolUsage[];
}

/** The whole answer: per key, per tool, with totals. */
export interface GlobeUsage {
  period: GlobeUsagePeriod;
  keys: GlobeKeyUsage[];
  totalCalls: number;
  toolTotals: Array<{ toolName: string; calls: number }>;
}

/**
 * Why a usage read did not land. Two cases, two operator responses: "this
 * address has no globe account" is a customer-shaped fact, "we could not talk to
 * the globe" is ours.
 */
export type GlobeUsageReadResult =
  | { ok: true; usage: GlobeUsage }
  | { ok: false; failure: "no-organization" | "unreachable"; detail: string };
