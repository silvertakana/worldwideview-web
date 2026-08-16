import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted setup — runs before module imports ────────────────────
// The real `resolvePlanFromPriceId` (src/lib/billing/constants.ts) builds its
// PRICE_ID_MAP from these env vars at import time, so they must exist before
// the module graph loads. Using the real resolver (not a mock) exercises the
// actual price-id → plan mapping.
vi.hoisted(() => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.PROVISIONING_API_URL = "https://globe.test:3443";
  process.env.CROSS_SERVICE_SECRET = "test-cross-service-secret";
  process.env.STRIPE_PRO_PRICE_ID = "price_pro_monthly";
  process.env.STRIPE_PRO_ANNUAL_PRICE_ID = "price_pro_yearly";
  process.env.STRIPE_TEAM_MONTHLY_PRICE_ID = "price_team_monthly";
  process.env.STRIPE_TEAM_ANNUAL_PRICE_ID = "price_team_yearly";
});

const {
  mockConstructEvent,
  mockRetrieveCheckoutSession,
  mockRetrieveCustomer,
  mockRetrieveSubscription,
  mockClaimWebhookEvent,
  mockCrossServiceFetch,
} = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
  mockRetrieveCheckoutSession: vi.fn(),
  mockRetrieveCustomer: vi.fn(),
  mockRetrieveSubscription: vi.fn(),
  mockClaimWebhookEvent: vi.fn(),
  mockCrossServiceFetch: vi.fn(),
}));

vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    webhooks: { constructEvent: mockConstructEvent },
    checkout: { sessions: { retrieve: mockRetrieveCheckoutSession } },
    customers: { retrieve: mockRetrieveCustomer },
    subscriptions: { retrieve: mockRetrieveSubscription },
  }),
}));

vi.mock("@/lib/cross-service/fetch", () => ({
  crossServiceFetch: mockCrossServiceFetch,
}));

vi.mock("@/lib/billing/webhook-idempotency", () => ({
  claimWebhookEvent: mockClaimWebhookEvent,
}));

// The REAL provision.ts and constants.ts are used: provisioning order is
// asserted at the crossServiceFetch level (provision → tier-sync).

import { POST } from "./route";

// ── Helpers ───────────────────────────────────────────────────────

const ok = () => new Response("", { status: 200 });
const fail = (status: number, body = "boom") => new Response(body, { status });

function buildEvent(type: string, object: Record<string, unknown>, id = `evt_${Date.now()}`) {
  return { id, type, data: { object } };
}

const TRIAL_END = 1893456000; // fixed timestamp for deterministic assertions

function buildCheckoutSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_test_123",
    client_reference_id: "user_abc",
    customer: "cus_abc",
    metadata: { userId: "user_abc" },
    customer_details: { name: "Test User" },
    subscription: {
      id: "sub_abc",
      trial_end: TRIAL_END,
      items: { data: [{ price: { id: "price_pro_monthly" } }] },
    },
    ...overrides,
  };
}

function buildSubscriptionEvent(type: string, status: string, priceId: string, overrides: Record<string, unknown> = {}) {
  return buildEvent(type, {
    id: "sub_abc",
    status,
    customer: "cus_abc",
    customer_email: "pay@example.com",
    items: { data: [{ price: { id: priceId } }] },
    ...overrides,
  });
}

function buildRequest(body: string, sig: string | null = "valid_sig") {
  return new Request("https://wwv.local:3001/api/billing/webhook", {
    method: "POST",
    headers: sig ? { "stripe-signature": sig } : {},
    body,
  });
}

function tierSyncCall(index: number) {
  return mockCrossServiceFetch.mock.calls[index][1].body;
}

function syncPaths(): unknown[] {
  return mockCrossServiceFetch.mock.calls.map((c) => c[0]);
}

// ── Setup ─────────────────────────────────────────────────────────

beforeEach(() => {
  mockConstructEvent.mockReset();
  mockRetrieveCheckoutSession.mockReset();
  mockRetrieveCustomer.mockReset();
  mockRetrieveSubscription.mockReset();
  mockClaimWebhookEvent.mockReset();
  mockCrossServiceFetch.mockReset();

  mockClaimWebhookEvent.mockResolvedValue("processed");
  mockCrossServiceFetch.mockResolvedValue(ok());
  // Canary: a test that forgets to configure constructEvent fails loudly
  // instead of silently passing via the handler's catch-all 200.
  mockConstructEvent.mockImplementation(() => {
    throw new Error("mockConstructEvent not configured for this test");
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────

describe("POST /api/billing/webhook — signature verification", () => {
  it("returns 400 and never claims the event when the signature is invalid", async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature");
    });

    const res = await POST(buildRequest("raw body", "bad_sig"));

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Webhook Error: No signatures found");
    expect(mockClaimWebhookEvent).not.toHaveBeenCalled();
  });

  it("returns 400 when the stripe-signature header is absent (constructEvent gets null)", async () => {
    mockConstructEvent.mockImplementation((_body: unknown, sig: string | null) => {
      expect(sig).toBeNull();
      throw new Error("No signatures found");
    });

    const res = await POST(buildRequest("raw body", null));

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Webhook Error: No signatures found");
    expect(mockClaimWebhookEvent).not.toHaveBeenCalled();
  });
});

describe("POST /api/billing/webhook — checkout.session.completed", () => {
  it("provisions the workspace BEFORE syncing the tier (PMT-001 order), success path", async () => {
    const event = buildEvent("checkout.session.completed", {
      id: "cs_test_123",
      customer_email: "pay@example.com",
      customer: "cus_abc",
    });
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveCheckoutSession.mockResolvedValue(buildCheckoutSession());

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(mockCrossServiceFetch).toHaveBeenCalledTimes(2);

    // Provision first...
    expect(syncPaths()).toEqual(["/api/provision", "/api/service/tier-sync"]);
    const provisionBody = mockCrossServiceFetch.mock.calls[0][1].body;
    expect(provisionBody.email).toBe("pay@example.com");
    expect(provisionBody.hubUserId).toBe("user_abc");
    expect(provisionBody.name).toBe("Test User");
    expect(provisionBody.subdomain).toBe("pay");

    // ...then tier-sync with trialing status and the subscription's trial end.
    const syncBody = tierSyncCall(1);
    expect(syncBody).toEqual({
      email: "pay@example.com",
      tier: "pro",
      status: "trialing",
      trialEndsAt: new Date(TRIAL_END * 1000).toISOString(),
    });
  });

  it("retrieves the checkout session with the subscription expand options", async () => {
    const event = buildEvent("checkout.session.completed", {
      id: "cs_test_123",
      customer_email: "pay@example.com",
    });
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveCheckoutSession.mockResolvedValue(buildCheckoutSession());

    await POST(buildRequest(JSON.stringify(event)));

    expect(mockRetrieveCheckoutSession).toHaveBeenCalledWith("cs_test_123", {
      expand: ["subscription", "subscription.items.data.price"],
    });
  });

  it("skips provisioning when no hubUserId is present, but still syncs the tier", async () => {
    const event = buildEvent("checkout.session.completed", {
      id: "cs_test_123",
      customer_email: "pay@example.com",
    });
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveCheckoutSession.mockResolvedValue(
      buildCheckoutSession({ client_reference_id: null, metadata: {} }),
    );

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(mockCrossServiceFetch).toHaveBeenCalledTimes(1);
    expect(syncPaths()).toEqual(["/api/service/tier-sync"]);
  });

  it("logs a structured error with session/email/customer identifiers when hubUserId is missing (loud skip)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const event = buildEvent("checkout.session.completed", {
      id: "cs_test_123",
      customer_email: "orphan@example.com",
      customer: "cus_orphan",
    });
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveCheckoutSession.mockResolvedValue(
      buildCheckoutSession({
        id: "cs_orphan_123",
        client_reference_id: null,
        metadata: {},
        customer: "cus_orphan",
      }),
    );

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    const logMsg = errorSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes("no hubUserId"));
    expect(logMsg).toBeDefined();
    expect(logMsg).toContain("sessionId=cs_orphan_123");
    expect(logMsg).toContain("email=orphan@example.com");
    expect(logMsg).toContain("customerId=cus_orphan");
    expect(logMsg).toContain("eventId=");
  });

  it("breaks without syncing when no email is resolvable (deleted customer)", async () => {
    const event = buildEvent("checkout.session.completed", {
      id: "cs_test_123",
      customer: "cus_abc",
    });
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveCheckoutSession.mockResolvedValue(buildCheckoutSession());
    mockRetrieveCustomer.mockResolvedValue({ id: "cus_abc", deleted: true });

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
  });

  it("falls back to an outbound customer retrieve when the payload carries no email", async () => {
    const event = buildEvent("checkout.session.completed", {
      id: "cs_test_123",
      customer: "cus_abc",
    });
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveCheckoutSession.mockResolvedValue(buildCheckoutSession());
    mockRetrieveCustomer.mockResolvedValue({
      id: "cus_abc",
      deleted: false,
      email: "outbound@example.com",
    });

    await POST(buildRequest(JSON.stringify(event)));

    expect(mockRetrieveCustomer).toHaveBeenCalledWith("cus_abc");
    expect(tierSyncCall(1).email).toBe("outbound@example.com");
  });

  it("prefers the payload email over the outbound retrieve (PMT-009)", async () => {
    const event = buildEvent("checkout.session.completed", {
      id: "cs_test_123",
      customer_email: "pay@example.com",
      customer: "cus_abc",
    });
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveCheckoutSession.mockResolvedValue(buildCheckoutSession());
    mockRetrieveCustomer.mockResolvedValue({
      id: "cus_abc",
      deleted: false,
      email: "outbound@example.com",
    });

    await POST(buildRequest(JSON.stringify(event)));

    expect(mockRetrieveCustomer).not.toHaveBeenCalled();
    expect(tierSyncCall(1).email).toBe("pay@example.com");
  });

  it("uses metadata.email as the hub-specific email fallback", async () => {
    const event = buildEvent("checkout.session.completed", {
      id: "cs_test_123",
      customer: "cus_abc",
      metadata: { email: "meta@example.com" },
    });
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveCheckoutSession.mockResolvedValue(buildCheckoutSession());

    await POST(buildRequest(JSON.stringify(event)));

    expect(mockRetrieveCustomer).not.toHaveBeenCalled();
    expect(tierSyncCall(1).email).toBe("meta@example.com");
  });

  it("still returns 200 received:true when a Stripe outbound call throws", async () => {
    const event = buildEvent("checkout.session.completed", {
      id: "cs_test_123",
      customer_email: "pay@example.com",
    });
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveCheckoutSession.mockRejectedValue(new Error("stripe is down"));

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
  });
});

describe("POST /api/billing/webhook — customer.subscription.created", () => {
  it("syncs pro/trialing when a trial subscription is created", async () => {
    const event = buildSubscriptionEvent("customer.subscription.created", "trialing", "price_pro_monthly");
    mockConstructEvent.mockReturnValue(event);

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(mockCrossServiceFetch).toHaveBeenCalledTimes(1);
    expect(syncPaths()).toEqual(["/api/service/tier-sync"]);
    expect(tierSyncCall(0)).toEqual({
      email: "pay@example.com",
      tier: "pro",
      status: "trialing",
      trialEndsAt: null,
    });
    expect(mockRetrieveCustomer).not.toHaveBeenCalled();
  });
});

describe("POST /api/billing/webhook — customer.subscription.updated (status mapping)", () => {
  it.each([
    ["active", "active", "pro"],
    ["trialing", "trialing", "pro"],
    ["past_due", "past_due", "pro"],
    ["canceled", "canceled", "free"],
    ["incomplete_expired", "canceled", "free"],
    ["paused", "suspended", "pro"],
    ["unknown_status", "suspended", "pro"],
  ])("maps Stripe status %s → %s with tier %s", async (inputStatus, expectedStatus, expectedTier) => {
    const event = buildSubscriptionEvent("customer.subscription.updated", inputStatus, "price_pro_monthly");
    mockConstructEvent.mockReturnValue(event);

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(tierSyncCall(0)).toEqual({
      email: "pay@example.com",
      tier: expectedTier,
      status: expectedStatus,
      trialEndsAt: null,
    });
  });

  it("resolves the team plan from the subscription price ID", async () => {
    const event = buildSubscriptionEvent("customer.subscription.updated", "active", "price_team_monthly");
    mockConstructEvent.mockReturnValue(event);

    await POST(buildRequest(JSON.stringify(event)));

    expect(tierSyncCall(0).tier).toBe("team");
    expect(tierSyncCall(0).status).toBe("active");
  });

  it("forces free/canceled even when the price ID resolves to a paid plan", async () => {
    const event = buildSubscriptionEvent("customer.subscription.updated", "canceled", "price_team_monthly");
    mockConstructEvent.mockReturnValue(event);

    await POST(buildRequest(JSON.stringify(event)));

    expect(tierSyncCall(0)).toEqual({
      email: "pay@example.com",
      tier: "free",
      status: "canceled",
      trialEndsAt: null,
    });
  });

  it("falls back to an outbound customer retrieve when the payload lacks an email", async () => {
    const event = buildEvent("customer.subscription.updated", {
      id: "sub_abc",
      status: "active",
      customer: "cus_x",
      items: { data: [{ price: { id: "price_pro_monthly" } }] },
    });
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveCustomer.mockResolvedValue({ id: "cus_x", deleted: false, email: "outbound@example.com" });

    await POST(buildRequest(JSON.stringify(event)));

    expect(mockRetrieveCustomer).toHaveBeenCalledWith("cus_x");
    expect(tierSyncCall(0).email).toBe("outbound@example.com");
  });
});

describe("POST /api/billing/webhook — customer.subscription.deleted", () => {
  it("syncs free/canceled (workspace lock cascade)", async () => {
    const event = buildEvent("customer.subscription.deleted", {
      id: "sub_del",
      customer: "cus_del",
      customer_email: "cancel@example.com",
    });
    mockConstructEvent.mockReturnValue(event);

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(mockCrossServiceFetch).toHaveBeenCalledTimes(1);
    expect(tierSyncCall(0)).toEqual({
      email: "cancel@example.com",
      tier: "free",
      status: "canceled",
      trialEndsAt: null,
    });
  });

  it("resolves the email outbound when the deleted payload has none", async () => {
    const event = buildEvent("customer.subscription.deleted", {
      id: "sub_del",
      customer: "cus_del",
    });
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveCustomer.mockResolvedValue({ id: "cus_del", deleted: false, email: "outbound@example.com" });

    await POST(buildRequest(JSON.stringify(event)));

    expect(mockRetrieveCustomer).toHaveBeenCalledWith("cus_del");
    expect(tierSyncCall(0).email).toBe("outbound@example.com");
  });
});

describe("POST /api/billing/webhook — invoice.payment_failed", () => {
  it("resolves the plan from the subscription price ID and syncs past_due (PMT-002/006)", async () => {
    const event = buildEvent("invoice.payment_failed", {
      customer: "cus_fail",
      customer_email: "fail@example.com",
      subscription: "sub_fail",
    });
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveSubscription.mockResolvedValue({
      items: { data: [{ price: { id: "price_pro_monthly" } }] },
    });

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(mockRetrieveSubscription).toHaveBeenCalledWith("sub_fail", {
      expand: ["items.data.price"],
    });
    expect(tierSyncCall(0)).toEqual({
      email: "fail@example.com",
      tier: "pro",
      status: "past_due",
      trialEndsAt: null,
    });
  });

  it("resolves the team tier from the subscription price ID", async () => {
    const event = buildEvent("invoice.payment_failed", {
      customer: "cus_fail",
      customer_email: "fail@example.com",
      subscription: "sub_fail",
    });
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveSubscription.mockResolvedValue({
      items: { data: [{ price: { id: "price_team_monthly" } }] },
    });

    await POST(buildRequest(JSON.stringify(event)));

    expect(tierSyncCall(0).tier).toBe("team");
    expect(tierSyncCall(0).status).toBe("past_due");
  });

  it("defaults to pro without crashing when the price ID is unknown", async () => {
    const event = buildEvent("invoice.payment_failed", {
      customer: "cus_fail",
      customer_email: "fail@example.com",
      subscription: "sub_fail",
    });
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveSubscription.mockResolvedValue({
      items: { data: [{ price: { id: "price_unknown" } }] },
    });

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(tierSyncCall(0).tier).toBe("pro");
    expect(tierSyncCall(0).status).toBe("past_due");
  });

  it("defaults to pro and still syncs past_due when the subscription retrieve fails", async () => {
    const event = buildEvent("invoice.payment_failed", {
      customer: "cus_fail",
      customer_email: "fail@example.com",
      subscription: "sub_fail",
    });
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveSubscription.mockRejectedValue(new Error("network"));

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(tierSyncCall(0).tier).toBe("pro");
    expect(tierSyncCall(0).status).toBe("past_due");
  });
});

describe("POST /api/billing/webhook — idempotency (PMT-008)", () => {
  it("returns 200 duplicate:true and skips processing for a duplicate event ID", async () => {
    const event = buildSubscriptionEvent("customer.subscription.updated", "active", "price_pro_monthly");
    event.id = "evt_duplicate_001";
    mockConstructEvent.mockReturnValue(event);
    mockClaimWebhookEvent.mockResolvedValue("duplicate");

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: true });
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
    expect(mockRetrieveCustomer).not.toHaveBeenCalled();
  });

  it("claims the event id with the idempotency ledger for every event", async () => {
    const event = buildSubscriptionEvent("customer.subscription.updated", "active", "price_pro_monthly");
    event.id = "evt_claim_me";
    mockConstructEvent.mockReturnValue(event);

    await POST(buildRequest(JSON.stringify(event)));

    expect(mockClaimWebhookEvent).toHaveBeenCalledWith("evt_claim_me");
  });

  it("fails open (processes anyway) when the idempotency store is unavailable", async () => {
    const event = buildSubscriptionEvent("customer.subscription.updated", "active", "price_pro_monthly");
    mockConstructEvent.mockReturnValue(event);
    mockClaimWebhookEvent.mockResolvedValue("unknown");

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(mockCrossServiceFetch).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/billing/webhook — tier-sync retry (PMT-007)", () => {
  it("retries once after a failed first attempt and succeeds on the second", async () => {
    vi.useFakeTimers();
    const event = buildEvent("customer.subscription.deleted", {
      id: "sub_r",
      customer: "cus_r",
      customer_email: "retry@example.com",
    });
    mockConstructEvent.mockReturnValue(event);
    mockCrossServiceFetch
      .mockResolvedValueOnce(fail(500, "globe exploded"))
      .mockResolvedValueOnce(ok());

    const postPromise = POST(buildRequest(JSON.stringify(event)));
    await vi.advanceTimersByTimeAsync(500);
    const res = await postPromise;

    expect(res.status).toBe(200);
    expect(mockCrossServiceFetch).toHaveBeenCalledTimes(2);
    expect(syncPaths()).toEqual(["/api/service/tier-sync", "/api/service/tier-sync"]);
  });

  it("returns 200 after both attempts fail, logging the final failure", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const event = buildEvent("customer.subscription.deleted", {
      id: "sub_r2",
      customer: "cus_r2",
      customer_email: "retry2@example.com",
    });
    mockConstructEvent.mockReturnValue(event);
    mockCrossServiceFetch.mockResolvedValue(fail(500, "globe exploded"));

    const postPromise = POST(buildRequest(JSON.stringify(event)));
    await vi.advanceTimersByTimeAsync(500);
    const res = await postPromise;

    expect(res.status).toBe(200);
    expect(mockCrossServiceFetch).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("attempt 2/2"));
  });
});

describe("POST /api/billing/webhook — unknown events", () => {
  it("returns 200 for an unknown event type without syncing", async () => {
    const event = buildEvent("charge.succeeded", { id: "ch_123" });
    mockConstructEvent.mockReturnValue(event);

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
  });
});
