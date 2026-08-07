import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted setup — runs before module imports ────────────────────
// The real `resolvePlanFromPriceId` (src/lib/billing/constants.ts) builds its
// PRICE_ID_MAP from these env vars at import time, so they must exist before
// the module graph loads. Using the real resolver (not a mock) exercises the
// actual price-id → plan mapping.
vi.hoisted(() => {
  process.env.STRIPE_PRO_PRICE_ID = "price_pro_monthly";
  process.env.STRIPE_PRO_ANNUAL_PRICE_ID = "price_pro_yearly";
  process.env.STRIPE_TEAM_MONTHLY_PRICE_ID = "price_team_monthly";
  process.env.STRIPE_TEAM_ANNUAL_PRICE_ID = "price_team_yearly";
});

const {
  mockCustomersSearch,
  mockCustomersList,
  mockSubscriptionsList,
  mockGetHighestTier,
} = vi.hoisted(() => ({
  mockCustomersSearch: vi.fn(),
  mockCustomersList: vi.fn(),
  mockSubscriptionsList: vi.fn(),
  mockGetHighestTier: vi.fn(),
}));

vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    customers: { search: mockCustomersSearch, list: mockCustomersList },
    subscriptions: { list: mockSubscriptionsList },
  }),
}));

vi.mock("@/lib/auth/entitlements", () => ({
  getHighestTier: mockGetHighestTier,
}));

// The REAL constants.ts resolver is used so the price-id → plan mapping is
// exercised end to end.

import { getHubTierFallback } from "./tier-fallback";

// ── Helpers ───────────────────────────────────────────────────────

const USER_ID = "user_abc";
const EMAIL = "pay@example.com";

function buildCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: "cus_abc",
    email: EMAIL,
    metadata: { userId: USER_ID },
    deleted: false,
    ...overrides,
  };
}

function buildSub(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_abc",
    status: "active",
    created: 1_000,
    trial_end: null,
    items: { data: [{ price: { id: "price_pro_monthly" } }] },
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────

beforeEach(() => {
  mockCustomersSearch.mockReset();
  mockCustomersList.mockReset();
  mockSubscriptionsList.mockReset();
  mockGetHighestTier.mockReset();

  // Defaults: no Stripe customer and no entitlement → null. Each test
  // configures what it needs; an unconfigured test fails via its assertions.
  mockCustomersSearch.mockResolvedValue({ data: [] });
  mockCustomersList.mockResolvedValue({ data: [] });
  mockGetHighestTier.mockResolvedValue("free");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────

describe("getHubTierFallback — plan resolution from price ID (PMT-005)", () => {
  it("resolves pro from the pro monthly price ID", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [buildCustomer()] });
    mockSubscriptionsList.mockResolvedValue({ data: [buildSub()] });

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(result).toEqual({
      plan: "pro",
      status: "active",
      trialEndsAt: null,
      isTrialing: false,
    });
  });

  it("resolves pro from the pro annual price ID", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [buildCustomer()] });
    mockSubscriptionsList.mockResolvedValue({
      data: [buildSub({ items: { data: [{ price: { id: "price_pro_yearly" } }] } })],
    });

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(result?.plan).toBe("pro");
  });

  it("resolves team from the team monthly price ID", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [buildCustomer()] });
    mockSubscriptionsList.mockResolvedValue({
      data: [buildSub({ items: { data: [{ price: { id: "price_team_monthly" } }] } })],
    });

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(result?.plan).toBe("team");
  });

  it("defaults to pro without crashing when the price ID is unknown", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [buildCustomer()] });
    mockSubscriptionsList.mockResolvedValue({
      data: [buildSub({ items: { data: [{ price: { id: "price_unknown" } }] } })],
    });

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(result).not.toBeNull();
    expect(result?.plan).toBe("pro");
  });

  it("defaults to pro when the subscription's first item has no price", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [buildCustomer()] });
    mockSubscriptionsList.mockResolvedValue({
      data: [buildSub({ items: { data: [{ price: null }] } })],
    });

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(result?.plan).toBe("pro");
  });
});

describe("getHubTierFallback — customer resolution (userId first, then email)", () => {
  it("searches Stripe customers by the userId metadata query", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [buildCustomer()] });
    mockSubscriptionsList.mockResolvedValue({ data: [buildSub()] });

    await getHubTierFallback(USER_ID, EMAIL);

    expect(mockCustomersSearch).toHaveBeenCalledWith({
      query: `metadata['userId']:'${USER_ID}'`,
      limit: 1,
    });
  });

  it("uses the userId-matched customer and never queries by email", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [buildCustomer()] });
    mockSubscriptionsList.mockResolvedValue({ data: [buildSub()] });

    await getHubTierFallback(USER_ID, EMAIL);

    expect(mockCustomersList).not.toHaveBeenCalled();
    expect(mockSubscriptionsList).toHaveBeenCalledWith({ customer: "cus_abc", limit: 10 });
  });

  it("falls back to an email lookup when the userId search finds nothing", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersList.mockResolvedValue({ data: [buildCustomer()] });
    mockSubscriptionsList.mockResolvedValue({ data: [buildSub()] });

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(mockCustomersList).toHaveBeenCalledWith({ email: EMAIL, limit: 1 });
    expect(result?.plan).toBe("pro");
  });
});

describe("getHubTierFallback — mismatched-customer rejection (2f42cb6)", () => {
  it("rejects an email-matched customer whose metadata.userId belongs to another user", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersList.mockResolvedValue({
      data: [buildCustomer({ metadata: { userId: "user_other" } })],
    });
    mockGetHighestTier.mockResolvedValue("free");

    const result = await getHubTierFallback(USER_ID, EMAIL);

    // The foreign customer must not grant a tier: no subscription is listed
    // for it, and the entitlement fallback (free) yields nothing.
    expect(mockSubscriptionsList).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("falls through to the entitlement path when the email match is rejected", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersList.mockResolvedValue({
      data: [buildCustomer({ metadata: { userId: "user_other" } })],
    });
    mockGetHighestTier.mockResolvedValue("pro");

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(mockSubscriptionsList).not.toHaveBeenCalled();
    expect(mockGetHighestTier).toHaveBeenCalledWith(USER_ID);
    expect(result).toEqual({
      plan: "pro",
      status: "active",
      trialEndsAt: null,
      isTrialing: false,
    });
  });

  it("accepts an email-matched customer carrying the same metadata.userId", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersList.mockResolvedValue({ data: [buildCustomer()] });
    mockSubscriptionsList.mockResolvedValue({ data: [buildSub()] });

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(result?.plan).toBe("pro");
    expect(mockSubscriptionsList).toHaveBeenCalledWith({ customer: "cus_abc", limit: 10 });
  });

  it("accepts an email-matched customer with no metadata.userId (legacy record)", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersList.mockResolvedValue({ data: [buildCustomer({ metadata: {} })] });
    mockSubscriptionsList.mockResolvedValue({ data: [buildSub()] });

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(result?.plan).toBe("pro");
  });
});

describe("getHubTierFallback — newest subscription wins (PMT-010)", () => {
  it("selects the newest live subscription when a customer has multiple", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [buildCustomer()] });
    mockSubscriptionsList.mockResolvedValue({
      data: [
        buildSub({
          id: "sub_old",
          created: 1_000,
          items: { data: [{ price: { id: "price_pro_monthly" } }] },
        }),
        buildSub({
          id: "sub_new",
          created: 2_000,
          items: { data: [{ price: { id: "price_team_monthly" } }] },
        }),
      ],
    });

    const result = await getHubTierFallback(USER_ID, EMAIL);

    // Newest (sub_new, created 2000) wins over the older pro sub → team.
    expect(result?.plan).toBe("team");
  });

  it("prefers the newest live subscription across different live statuses", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [buildCustomer()] });
    mockSubscriptionsList.mockResolvedValue({
      data: [
        buildSub({
          id: "sub_older_active",
          created: 1_000,
          status: "active",
          items: { data: [{ price: { id: "price_pro_monthly" } }] },
        }),
        buildSub({
          id: "sub_newer_trialing",
          created: 2_000,
          status: "trialing",
          items: { data: [{ price: { id: "price_team_monthly" } }] },
        }),
      ],
    });

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(result?.plan).toBe("team");
    expect(result?.status).toBe("trialing");
    expect(result?.isTrialing).toBe(true);
  });

  it("skips a canceled newest sub and selects the older live one", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [buildCustomer()] });
    mockSubscriptionsList.mockResolvedValue({
      data: [
        buildSub({
          id: "sub_canceled",
          created: 2_000,
          status: "canceled",
          items: { data: [{ price: { id: "price_team_monthly" } }] },
        }),
        buildSub({
          id: "sub_active",
          created: 1_000,
          status: "active",
          items: { data: [{ price: { id: "price_pro_monthly" } }] },
        }),
      ],
    });

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(result?.plan).toBe("pro");
  });
});

describe("getHubTierFallback — live subscription status handling", () => {
  it.each([
    ["active", "active", false],
    ["trialing", "trialing", true],
    ["past_due", "past_due", false],
  ] as const)("maps Stripe status %s → hub status %s (isTrialing=%s)", async (stripeStatus, hubStatus, isTrialing) => {
    mockCustomersSearch.mockResolvedValue({ data: [buildCustomer()] });
    mockSubscriptionsList.mockResolvedValue({ data: [buildSub({ status: stripeStatus })] });

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(result).toEqual({
      plan: "pro",
      status: hubStatus,
      trialEndsAt: null,
      isTrialing,
    });
  });

  it("does not grant a tier when every subscription is canceled (falls to entitlement)", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [buildCustomer()] });
    mockSubscriptionsList.mockResolvedValue({
      data: [
        buildSub({ status: "canceled" }),
        buildSub({ id: "sub_2", status: "canceled", created: 2_000 }),
      ],
    });
    mockGetHighestTier.mockResolvedValue("pro");

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(result).toEqual({
      plan: "pro",
      status: "active",
      trialEndsAt: null,
      isTrialing: false,
    });
  });

  it("does not treat unpaid or incomplete subscriptions as live", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [buildCustomer()] });
    mockSubscriptionsList.mockResolvedValue({
      data: [
        buildSub({ status: "unpaid" }),
        buildSub({ id: "sub_2", status: "incomplete", created: 2_000 }),
      ],
    });
    mockGetHighestTier.mockResolvedValue("free");

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(mockGetHighestTier).toHaveBeenCalledWith(USER_ID);
    expect(result).toBeNull();
  });
});

describe("getHubTierFallback — trial handling (PMT-011)", () => {
  const FUTURE_TRIAL_END = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
  const PAST_TRIAL_END = Math.floor(Date.now() / 1000) - 24 * 60 * 60;

  it("returns trialEndsAt and isTrialing:true for a trialing sub with a future trial end", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [buildCustomer()] });
    mockSubscriptionsList.mockResolvedValue({
      data: [buildSub({ status: "trialing", trial_end: FUTURE_TRIAL_END })],
    });

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(result).toEqual({
      plan: "pro",
      status: "trialing",
      trialEndsAt: new Date(FUTURE_TRIAL_END * 1000).toISOString(),
      isTrialing: true,
    });
  });

  it("reports trialEndsAt for a past trial end without changing the trialing status", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [buildCustomer()] });
    mockSubscriptionsList.mockResolvedValue({
      data: [buildSub({ status: "trialing", trial_end: PAST_TRIAL_END })],
    });

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(result?.status).toBe("trialing");
    expect(result?.isTrialing).toBe(true);
    expect(result?.trialEndsAt).toBe(new Date(PAST_TRIAL_END * 1000).toISOString());
  });

  it("returns trialEndsAt:null for a live sub with no trial_end", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [buildCustomer()] });
    mockSubscriptionsList.mockResolvedValue({ data: [buildSub()] });

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(result?.trialEndsAt).toBeNull();
    expect(result?.isTrialing).toBe(false);
  });
});

describe("getHubTierFallback — entitlement fallback (getHighestTier)", () => {
  it("returns the hub entitlement tier when no Stripe customer exists", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersList.mockResolvedValue({ data: [] });
    mockGetHighestTier.mockResolvedValue("pro");

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(result).toEqual({
      plan: "pro",
      status: "active",
      trialEndsAt: null,
      isTrialing: false,
    });
  });

  it("maps an enterprise entitlement to the enterprise plan", async () => {
    mockGetHighestTier.mockResolvedValue("enterprise");

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(result?.plan).toBe("enterprise");
    expect(result?.status).toBe("active");
  });

  it("returns null when the highest entitlement tier is free", async () => {
    mockGetHighestTier.mockResolvedValue("free");

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(result).toBeNull();
  });

  it("falls back to entitlements when the matched Stripe customer is deleted", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersList.mockResolvedValue({ data: [buildCustomer({ deleted: true })] });
    mockGetHighestTier.mockResolvedValue("pro");

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(mockSubscriptionsList).not.toHaveBeenCalled();
    expect(result).toEqual({
      plan: "pro",
      status: "active",
      trialEndsAt: null,
      isTrialing: false,
    });
  });

  it("falls back to entitlements when the Stripe lookup throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockCustomersSearch.mockRejectedValue(new Error("stripe is down"));
    mockGetHighestTier.mockResolvedValue("pro");

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(errorSpy).toHaveBeenCalledWith(
      "[billing] Stripe fallback lookup failed:",
      expect.any(Error),
    );
    expect(result).toEqual({
      plan: "pro",
      status: "active",
      trialEndsAt: null,
      isTrialing: false,
    });
  });

  it("returns null when both Stripe and the entitlement lookup fail", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockCustomersSearch.mockRejectedValue(new Error("stripe is down"));
    mockGetHighestTier.mockRejectedValue(new Error("db is down"));

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
  });
});

describe("getHubTierFallback — hub-authoritative fallback path (ba77bc0)", () => {
  it("returns the hub-authoritative tier when the globe has no org (404 scenario)", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [buildCustomer()] });
    mockSubscriptionsList.mockResolvedValue({
      data: [
        buildSub({
          status: "active",
          items: { data: [{ price: { id: "price_pro_monthly" } }] },
        }),
      ],
    });

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(result).toEqual({
      plan: "pro",
      status: "active",
      trialEndsAt: null,
      isTrialing: false,
    });
  });

  it("resolves the plan through the email-fallback path when the userId search is empty", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersList.mockResolvedValue({ data: [buildCustomer()] });
    mockSubscriptionsList.mockResolvedValue({
      data: [buildSub({ items: { data: [{ price: { id: "price_pro_yearly" } }] } })],
    });

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(result?.plan).toBe("pro");
    expect(result?.status).toBe("active");
  });

  it("defaults unknown prices to pro in the end-to-end path without crashing", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersList.mockResolvedValue({ data: [buildCustomer({ metadata: {} })] });
    mockSubscriptionsList.mockResolvedValue({
      data: [
        buildSub({
          status: "trialing",
          items: { data: [{ price: { id: "price_unknown" } }] },
        }),
      ],
    });

    const result = await getHubTierFallback(USER_ID, EMAIL);

    expect(result).toEqual({
      plan: "pro",
      status: "trialing",
      trialEndsAt: null,
      isTrialing: true,
    });
  });
});
