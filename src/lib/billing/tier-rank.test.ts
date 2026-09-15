import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGetHubTierFallback, mockGetHighestTier, mockGetActiveOverride } = vi.hoisted(() => ({
  mockGetHubTierFallback: vi.fn(),
  mockGetHighestTier: vi.fn(),
  mockGetActiveOverride: vi.fn(),
}));

vi.mock("@/lib/billing/tier-fallback", () => ({ getHubTierFallback: mockGetHubTierFallback }));
vi.mock("@/lib/auth/entitlements", () => ({ getHighestTier: mockGetHighestTier }));
vi.mock("@/lib/billing/subscription-store", () => ({ getActiveOverride: mockGetActiveOverride }));

import { TIER_RANK, tierRank, resolveEffectiveHubTier } from "@/lib/billing/tier-rank";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetHubTierFallback.mockResolvedValue(null);
  mockGetHighestTier.mockResolvedValue("free");
  mockGetActiveOverride.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ──────────────────────────── TIER_RANK ──────────────────────────── */

describe("TIER_RANK", () => {
  it("orders the hub tiers from free upward", () => {
    expect(TIER_RANK.free).toBeLessThan(TIER_RANK.beta_tester);
    expect(TIER_RANK.beta_tester).toBeLessThan(TIER_RANK.early_access);
    expect(TIER_RANK.early_access).toBeLessThan(TIER_RANK.pro);
    expect(TIER_RANK.pro).toBeLessThan(TIER_RANK.team);
    expect(TIER_RANK.team).toBeLessThan(TIER_RANK.enterprise);
  });

  it("represents team, which the legacy hub map cannot", () => {
    // src/lib/auth/entitlements.ts:32-34 has no "team" key, so its `?? 0`
    // fallback would score a team entitlement the same as free.
    expect(TIER_RANK.team).toBeGreaterThan(0);
    expect(TIER_RANK.team).toBeGreaterThan(TIER_RANK.pro);
  });

  it("scores canceled the same as free", () => {
    expect(TIER_RANK.canceled).toBe(TIER_RANK.free);
  });

  it("scores an unknown tier the same as free, so a bad string cannot outrank a real tier", () => {
    expect(tierRank("platinum")).toBe(tierRank("free"));
    expect(tierRank("enterprise")).toBeGreaterThan(tierRank("platinum"));
  });

  it("treats null and undefined as free", () => {
    expect(tierRank(null)).toBe(0);
    expect(tierRank(undefined)).toBe(0);
  });
});

/* ──────────────────── resolveEffectiveHubTier ──────────────────── */

describe("resolveEffectiveHubTier", () => {
  it("reports free with the raw source values when no source claims a paid tier", async () => {
    const result = await resolveEffectiveHubTier("user-1", "user@example.com");
    // The entitlement source reports its own floor tier as "free"; the resolved
    // tier is free either way, and null means "this source found nothing".
    expect(result.tier).toBe("free");
    expect(result.tiers).toEqual({ stripe: null, entitlement: "free", override: null });
    expect(result.errors).toEqual({});
  });

  it("prefers the highest-ranked source over source order", async () => {
    mockGetHubTierFallback.mockResolvedValue({ plan: "pro", status: "active" });
    mockGetHighestTier.mockResolvedValue("enterprise");

    const result = await resolveEffectiveHubTier("user-1", "user@example.com");

    expect(result.tier).toBe("enterprise");
    expect(result.source).toBe("entitlement");
  });

  it("breaks a tie in favour of an operator override", async () => {
    mockGetHubTierFallback.mockResolvedValue({ plan: "team", status: "active" });
    mockGetHighestTier.mockResolvedValue("team");
    mockGetActiveOverride.mockResolvedValue({ id: "ovr-1", user_id: "user-1", tier: "team" });

    const result = await resolveEffectiveHubTier("user-1", "user@example.com");

    expect(result.tier).toBe("team");
    expect(result.source).toBe("override");
  });

  it("breaks a tie between stripe and entitlement in favour of stripe", async () => {
    mockGetHubTierFallback.mockResolvedValue({ plan: "pro", status: "active" });
    mockGetHighestTier.mockResolvedValue("pro");

    const result = await resolveEffectiveHubTier("user-1", "user@example.com");

    expect(result.source).toBe("stripe");
  });

  it("ranks team above pro across sources", async () => {
    mockGetHubTierFallback.mockResolvedValue({ plan: "pro", status: "active" });
    mockGetActiveOverride.mockResolvedValue({ id: "ovr-1", user_id: "user-1", tier: "team" });

    const result = await resolveEffectiveHubTier("user-1", "user@example.com");

    expect(result.tier).toBe("team");
    expect(result.source).toBe("override");
  });

  it("does not let a broken source hide another source's paid tier", async () => {
    mockGetHubTierFallback.mockRejectedValue(new Error("stripe exploded"));
    mockGetHighestTier.mockResolvedValue("pro");

    const result = await resolveEffectiveHubTier("user-1", "user@example.com");

    expect(result.tier).toBe("pro");
    expect(result.source).toBe("entitlement");
    expect(result.errors.stripe).toBe("stripe exploded");
    expect(result.tiers.stripe).toBeNull();
  });

  it("still returns a tier when every source fails", async () => {
    mockGetHubTierFallback.mockRejectedValue(new Error("stripe down"));
    mockGetHighestTier.mockRejectedValue(new Error("db down"));
    mockGetActiveOverride.mockRejectedValue(new Error("no client"));

    const result = await resolveEffectiveHubTier("user-1", "user@example.com");

    expect(result.tier).toBe("free");
    expect(Object.keys(result.errors).sort()).toEqual(["entitlement", "override", "stripe"]);
  });

  it("records a non-Error rejection without throwing", async () => {
    mockGetHighestTier.mockRejectedValue("plain string failure");

    const result = await resolveEffectiveHubTier("user-1", "user@example.com");

    expect(result.errors.entitlement).toBe("plain string failure");
  });

  it("ranks a canceled stripe plan as free", async () => {
    mockGetHubTierFallback.mockResolvedValue({ plan: "canceled", status: "canceled" });

    const result = await resolveEffectiveHubTier("user-1", "user@example.com");

    expect(tierRank(result.tier)).toBe(0);
  });
});
