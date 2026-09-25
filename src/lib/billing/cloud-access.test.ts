import { describe, it, expect, vi, beforeEach } from "vitest";

// The three stores this module reads all go through the service-role Supabase
// client, and the globe read goes over the HMAC-signed cross-service fetch.
// Stubbing them at the module boundary is what makes the POLICY below (which
// store wins, and what a refusal looks like) testable without a database.
const {
  mockGetSubscriptionForUser,
  mockGetSubscriptionByEmail,
  mockGetActiveOverride,
  mockGetHighestTier,
  mockReadGlobeTier,
} = vi.hoisted(() => ({
  mockGetSubscriptionForUser: vi.fn(),
  mockGetSubscriptionByEmail: vi.fn(),
  mockGetActiveOverride: vi.fn(),
  mockGetHighestTier: vi.fn(),
  mockReadGlobeTier: vi.fn(),
}));

vi.mock("@/lib/billing/subscription-store", () => ({
  getSubscriptionForUser: mockGetSubscriptionForUser,
  getSubscriptionByEmail: mockGetSubscriptionByEmail,
  getActiveOverride: mockGetActiveOverride,
}));

vi.mock("@/lib/auth/entitlements", () => ({
  getHighestTier: mockGetHighestTier,
}));

vi.mock("@/lib/billing/globe-sync", () => ({
  readGlobeTier: mockReadGlobeTier,
}));

import { NO_ACCESS_MESSAGE, resolveCloudAccess, toGlobeTier } from "./cloud-access";
import type { SubscriptionRecord } from "@/lib/billing/billing-tables";

const USER = "user_abc";
const EMAIL = "pay@example.com";

function subscription(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    user_id: USER,
    email: EMAIL,
    stripe_subscription_id: "sub_1",
    status: "active",
    plan: "pro",
    ...overrides,
  };
}

/** No store has anything to say: the only state that may produce a refusal. */
function emptyStores() {
  mockGetSubscriptionForUser.mockResolvedValue([]);
  mockGetSubscriptionByEmail.mockResolvedValue(null);
  mockGetActiveOverride.mockResolvedValue(null);
  mockGetHighestTier.mockResolvedValue("free");
}

beforeEach(() => {
  mockGetSubscriptionForUser.mockReset();
  mockGetSubscriptionByEmail.mockReset();
  mockGetActiveOverride.mockReset();
  mockGetHighestTier.mockReset();
  mockReadGlobeTier.mockReset();

  emptyStores();

  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("resolveCloudAccess — a paying customer is let in", () => {
  // The production defect this module exists to fix: the one live paying
  // account has a subscription row and ZERO user_entitlements rows, and was
  // refused. A subscription alone must be sufficient.
  it("grants access on an active subscription with no entitlement at all", async () => {
    mockGetSubscriptionForUser.mockResolvedValue([subscription()]);

    const access = await resolveCloudAccess({ userId: USER, email: EMAIL });

    expect(access.allowed).toBe(true);
    expect(access.source).toBe("subscription");
    expect(access.tier).toBe("pro");
    expect(access.plan).toBe("pro");
    expect(access.instanceLimit).toBeNull();
  });

  it.each(["active", "trialing", "past_due"])("treats a %s subscription as access", async (status) => {
    mockGetSubscriptionForUser.mockResolvedValue([subscription({ status })]);

    await expect(resolveCloudAccess({ userId: USER, email: EMAIL })).resolves.toMatchObject({
      allowed: true,
      source: "subscription",
      tier: "pro",
    });
  });

  it.each(["canceled", "suspended"])("treats a %s subscription as no access", async (status) => {
    mockGetSubscriptionForUser.mockResolvedValue([subscription({ status })]);

    const access = await resolveCloudAccess({ userId: USER, email: EMAIL });

    expect(access.allowed).toBe(false);
    expect(access.source).toBe("none");
  });

  it("ignores an active row whose plan ranks as free", async () => {
    mockGetSubscriptionForUser.mockResolvedValue([subscription({ plan: "free" })]);

    await expect(resolveCloudAccess({ userId: USER, email: EMAIL })).resolves.toMatchObject({
      allowed: false,
      tier: "free",
    });
  });

  it("falls back to the email match when the row carries no user id", async () => {
    mockGetSubscriptionForUser.mockResolvedValue([]);
    mockGetSubscriptionByEmail.mockResolvedValue(subscription({ user_id: null }));

    const access = await resolveCloudAccess({ userId: USER, email: EMAIL });

    expect(mockGetSubscriptionByEmail).toHaveBeenCalledWith(EMAIL);
    expect(access.allowed).toBe(true);
    expect(access.tier).toBe("pro");
  });

  it("does not consult the email when the user id already matched", async () => {
    mockGetSubscriptionForUser.mockResolvedValue([subscription()]);

    await resolveCloudAccess({ userId: USER, email: EMAIL });

    expect(mockGetSubscriptionByEmail).not.toHaveBeenCalled();
  });
});

describe("resolveCloudAccess — the code store still works, quietly", () => {
  it.each([
    ["beta_tester", 1],
    ["early_access", 3],
  ])("grants a legacy %s code holder access with an instanceLimit of %s", async (tier, limit) => {
    mockGetHighestTier.mockResolvedValue(tier);

    const access = await resolveCloudAccess({ userId: USER, email: EMAIL });

    expect(access.allowed).toBe(true);
    expect(access.source).toBe("legacy-code");
    expect(access.tier).toBe(tier);
    expect(access.instanceLimit).toBe(limit);
  });

  it("is a plan label, not an error, when nothing granted access", async () => {
    const access = await resolveCloudAccess({ userId: USER, email: EMAIL });

    expect(access).toMatchObject({
      allowed: false,
      source: "none",
      tier: "free",
      plan: "local",
      instanceLimit: 0,
    });
  });
});

describe("resolveCloudAccess — one store winning over another", () => {
  it("lets a deliberate operator override raise the tier above a subscription", async () => {
    mockGetSubscriptionForUser.mockResolvedValue([subscription({ plan: "pro" })]);
    mockGetActiveOverride.mockResolvedValue({ tier: "team" });

    await expect(resolveCloudAccess({ userId: USER, email: EMAIL })).resolves.toMatchObject({
      allowed: true,
      source: "override",
      tier: "team",
    });
  });

  it("takes the higher tier whichever store holds it", async () => {
    mockGetSubscriptionForUser.mockResolvedValue([subscription({ plan: "pro" })]);
    mockGetHighestTier.mockResolvedValue("enterprise");

    await expect(resolveCloudAccess({ userId: USER, email: EMAIL })).resolves.toMatchObject({
      source: "legacy-code",
      tier: "enterprise",
    });
  });

  it("prefers the override when two stores agree on the same tier", async () => {
    mockGetSubscriptionForUser.mockResolvedValue([subscription({ plan: "pro" })]);
    mockGetActiveOverride.mockResolvedValue({ tier: "pro" });

    await expect(resolveCloudAccess({ userId: USER, email: EMAIL })).resolves.toMatchObject({
      source: "override",
      tier: "pro",
    });
  });

  it("treats team as unlimited, the way the paid tiers are", async () => {
    mockGetActiveOverride.mockResolvedValue({ tier: "team" });

    await expect(resolveCloudAccess({ userId: USER, email: EMAIL })).resolves.toMatchObject({
      instanceLimit: null,
    });
  });
});

describe("resolveCloudAccess — a broken store never becomes a grant", () => {
  it("still grants through the code store when the subscription read throws", async () => {
    mockGetSubscriptionForUser.mockRejectedValue(new Error("supabase down"));
    mockGetHighestTier.mockResolvedValue("beta_tester");

    const access = await resolveCloudAccess({ userId: USER, email: EMAIL });

    expect(access.allowed).toBe(true);
    expect(access.source).toBe("legacy-code");
    expect(access.errors.subscription).toBe("supabase down");
  });

  it("refuses when every store throws", async () => {
    mockGetSubscriptionForUser.mockRejectedValue(new Error("subscriptions down"));
    mockGetActiveOverride.mockRejectedValue(new Error("overrides down"));
    mockGetHighestTier.mockRejectedValue(new Error("entitlements down"));

    const access = await resolveCloudAccess({ userId: USER, email: EMAIL });

    expect(access.allowed).toBe(false);
    expect(access.source).toBe("none");
    expect(access.errors).toEqual({
      subscription: "subscriptions down",
      override: "overrides down",
      "legacy-code": "entitlements down",
    });
  });

  it("records each store's contribution for the operator log", async () => {
    mockGetSubscriptionForUser.mockResolvedValue([subscription()]);
    mockGetHighestTier.mockResolvedValue("beta_tester");

    const access = await resolveCloudAccess({ userId: USER, email: EMAIL });

    expect(access.tiers).toEqual({
      subscription: "pro",
      override: null,
      "legacy-code": "beta_tester",
    });
  });
});

describe("NO_ACCESS_MESSAGE", () => {
  // Pinned here against the real module: the two provisioning route suites
  // assert this copy as a mocked boundary value, so this is the line that fails
  // if the customer-facing wording changes.
  it("names the plans page, not the redeem page", () => {
    expect(NO_ACCESS_MESSAGE).toBe(
      "No active plan. Choose a plan at /pricing to create your workspace.",
    );
  });
});

describe("toGlobeTier — a tier the globe can actually hold", () => {
  it.each(["free", "pro", "team", "enterprise"])("passes %s straight through", async (tier) => {
    await expect(toGlobeTier(tier, EMAIL)).resolves.toBe(tier);
    expect(mockReadGlobeTier).not.toHaveBeenCalled();
  });

  it.each(["beta_tester", "early_access"])(
    "keeps the globe's existing tier for the hub-only tier %s",
    async (tier) => {
      mockReadGlobeTier.mockResolvedValue({
        ok: true,
        state: { tier: "pro", status: "active", effectiveTier: "pro", effectiveStatus: "active", instanceCount: 1 },
      });

      await expect(toGlobeTier(tier, EMAIL)).resolves.toBe("pro");
      expect(mockReadGlobeTier).toHaveBeenCalledWith(EMAIL);
    },
  );

  it("falls back to free when the globe cannot be read", async () => {
    mockReadGlobeTier.mockResolvedValue({ ok: false, failure: "unreachable", detail: "ECONNREFUSED" });

    await expect(toGlobeTier("beta_tester", EMAIL)).resolves.toBe("free");
  });

  it("falls back to free when the globe holds a tier it cannot name", async () => {
    mockReadGlobeTier.mockResolvedValue({
      ok: true,
      state: { tier: "beta_tester", status: "active", effectiveTier: "beta_tester", effectiveStatus: "active", instanceCount: 0 },
    });

    await expect(toGlobeTier("beta_tester", EMAIL)).resolves.toBe("free");
  });
});
