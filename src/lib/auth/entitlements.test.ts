import { describe, it, expect, vi, beforeEach } from "vitest";

// getHighestTier reads through the service-role Supabase client, which throws
// unless the URL and service-role key are set. Stub the client so the ranking
// logic is exercised without a database.
const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockFrom }),
}));

import { getHighestTier } from "./entitlements";

interface EntitlementRow {
  id: string;
  user_id: string;
  tier: string;
  revoked_at: string | null;
  used_for_instance: boolean;
  grants_days: number;
}

function buildEntitlement(tier: string): EntitlementRow {
  return {
    id: `ent_${tier}`,
    user_id: "user_abc",
    tier,
    revoked_at: null,
    used_for_instance: false,
    grants_days: 30,
  };
}

/** Stub the `user_entitlements` read chain to resolve to `rows`. */
function mockEntitlements(rows: EntitlementRow[]) {
  mockFrom.mockImplementation(() => ({
    select: () => ({ eq: () => ({ is: () => Promise.resolve({ data: rows }) }) }),
  }));
}

describe("getHighestTier", () => {
  beforeEach(() => {
    mockFrom.mockReset();
  });

  it("returns free when the user has no entitlements", async () => {
    mockEntitlements([]);

    await expect(getHighestTier("user_abc")).resolves.toBe("free");
  });

  // These pairs are the ranking the globe's src/lib/org-tier.ts TIER_RANK
  // defines. `team` is purchasable on the hub, so a map that cannot rank it
  // scores a Team entitlement as free through the `?? 0` fallback.
  const ORDER_PAIRS: Array<[string, string]> = [
    ["beta_tester", "free"],
    ["early_access", "beta_tester"],
    ["pro", "early_access"],
    ["team", "pro"],
    ["enterprise", "team"],
  ];

  it.each(ORDER_PAIRS)("ranks %s above %s", async (higher, lower) => {
    mockEntitlements([buildEntitlement(lower), buildEntitlement(higher)]);

    await expect(getHighestTier("user_abc")).resolves.toBe(higher);
  });

  it("picks the highest tier regardless of query order", async () => {
    mockEntitlements([
      buildEntitlement("enterprise"),
      buildEntitlement("free"),
      buildEntitlement("team"),
    ]);

    await expect(getHighestTier("user_abc")).resolves.toBe("enterprise");
  });

  it("treats an unknown tier as free rather than above a known tier", async () => {
    mockEntitlements([buildEntitlement("mystery_tier"), buildEntitlement("beta_tester")]);

    await expect(getHighestTier("user_abc")).resolves.toBe("beta_tester");
  });
});
