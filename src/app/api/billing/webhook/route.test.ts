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
  mockCompleteWebhookEvent,
  mockFailWebhookEvent,
  mockCrossServiceFetch,
  mockAdminClient,
  mockGetUserById,
} = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
  mockRetrieveCheckoutSession: vi.fn(),
  mockRetrieveCustomer: vi.fn(),
  mockRetrieveSubscription: vi.fn(),
  mockClaimWebhookEvent: vi.fn(),
  mockCompleteWebhookEvent: vi.fn(),
  mockFailWebhookEvent: vi.fn(),
  mockCrossServiceFetch: vi.fn(),
  mockAdminClient: vi.fn(),
  mockGetUserById: vi.fn(),
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
  completeWebhookEvent: mockCompleteWebhookEvent,
  failWebhookEvent: mockFailWebhookEvent,
}));

// The durable-record writers are NOT mocked (see the test double below): the
// real records.ts / webhook-record.ts / hub-user.ts run against this client, so
// the ledger assertions below are about rows that would really be written.
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mockAdminClient }));

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
const PERIOD_END = 1896134400; // the paid-through date Stripe carries on the subscription

function buildCheckoutSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_test_123",
    client_reference_id: "user_abc",
    customer: "cus_abc",
    metadata: { userId: "user_abc" },
    customer_details: { name: "Test User" },
    subscription: {
      id: "sub_abc",
      status: "trialing",
      trial_end: TRIAL_END,
      current_period_end: PERIOD_END,
      cancel_at_period_end: false,
      items: { data: [{ price: { id: "price_pro_monthly", recurring: { interval: "month" } } }] },
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

// ── Durable-record test double ────────────────────────────────────
// The route writes billing_subscriptions (the ledger) through the real
// records.ts, so "the row was written", "the cuid was rejected" and "a manual
// row survived untouched" are proven end to end instead of asserted against a
// stub. createAdminClient() is the only seam. maybeSingle() answers the row
// probes from `probeRow`; every write resolves with `writeError`.
const dbWrites: { table: string; op: string; payload: Record<string, unknown> }[] = [];
let probeRow: Record<string, unknown> | null = null;
let writeError: { message: string } | null = null;

function makeBuilder(table: string) {
  const chain = {} as Record<string, unknown>;
  const record = (op: string) => (...args: unknown[]) => {
    if (op === "insert" || op === "update" || op === "upsert") {
      dbWrites.push({ table, op, payload: (args[0] ?? {}) as Record<string, unknown> });
    }
    return chain;
  };
  for (const op of ["select", "eq", "is", "neq", "order", "limit", "insert", "update", "upsert"]) {
    chain[op] = record(op);
  }
  chain.maybeSingle = () => Promise.resolve({ data: probeRow, error: null });
  chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve({ data: null, error: writeError }).then(resolve, reject);
  return chain;
}

function dbWritesFor(table: string) {
  return dbWrites.filter((write) => write.table === table);
}

function subscriptionWrites() {
  return dbWritesFor("billing_subscriptions");
}

function failureWrites() {
  return dbWritesFor("billing_failures");
}

// ── Setup ─────────────────────────────────────────────────────────

beforeEach(() => {
  mockConstructEvent.mockReset();
  mockRetrieveCheckoutSession.mockReset();
  mockRetrieveCustomer.mockReset();
  mockRetrieveSubscription.mockReset();
  mockClaimWebhookEvent.mockReset();
  mockCompleteWebhookEvent.mockReset();
  mockFailWebhookEvent.mockReset();
  mockCrossServiceFetch.mockReset();

  dbWrites.length = 0;
  probeRow = null;
  writeError = null;
  mockGetUserById.mockReset();
  // Realistic default: the hub's own uid resolves, a marketplace cuid does not.
  mockGetUserById.mockImplementation((uid: string) =>
    Promise.resolve(
      uid === "user_abc"
        ? { data: { user: { id: "user_abc" } }, error: null }
        : { data: { user: null }, error: { message: "User not found" } },
    ),
  );
  mockAdminClient.mockReset();
  mockAdminClient.mockReturnValue({
    from: (table: string) => makeBuilder(table),
    auth: { admin: { getUserById: mockGetUserById } },
  });

  // Default verdict: a fresh claim, so the handler processes the event.
  mockClaimWebhookEvent.mockResolvedValue("claimed");
  mockCompleteWebhookEvent.mockResolvedValue(undefined);
  mockFailWebhookEvent.mockResolvedValue(undefined);
  mockCrossServiceFetch.mockResolvedValue(ok());
  // Canary: a test that forgets to configure constructEvent fails loudly on the
  // 400 signature path instead of silently passing.
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

  it("fails the delivery and files a durable failure when the customer has no email (permanent absence)", async () => {
    const event = buildEvent(
      "checkout.session.completed",
      { id: "cs_test_123", customer: "cus_abc" },
      "evt_no_email",
    );
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveCheckoutSession.mockResolvedValue(buildCheckoutSession());
    // Stripe answers, and the customer genuinely has no email to be found.
    mockRetrieveCustomer.mockResolvedValue({ id: "cus_abc", deleted: true });

    const res = await POST(buildRequest(JSON.stringify(event)));

    // A1: this used to be a 200 with no work done at all - no provisioning, no
    // tier sync, and the event marked complete.
    expect(res.status).toBe(500);
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
    expect(mockCompleteWebhookEvent).not.toHaveBeenCalled();
    expect(mockFailWebhookEvent).toHaveBeenCalledWith(
      "evt_no_email",
      expect.stringContaining("no usable customer email"),
    );
    expect(failureWrites()).toEqual([
      {
        table: "billing_failures",
        op: "insert",
        payload: expect.objectContaining({
          stage: "resolve",
          event_id: "evt_no_email",
          event_type: "checkout.session.completed",
          email: null,
          attempts: 1,
          error: expect.stringContaining("no usable customer email"),
        }),
      },
    ]);
  });

  it("fails the delivery but files NO durable failure when the lookup itself fails (transient)", async () => {
    const event = buildEvent(
      "checkout.session.completed",
      { id: "cs_test_123", customer: "cus_abc" },
      "evt_blip",
    );
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveCheckoutSession.mockResolvedValue(buildCheckoutSession());
    mockRetrieveCustomer.mockRejectedValue(new Error("429 Too Many Requests"));

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(500);
    expect(mockCompleteWebhookEvent).not.toHaveBeenCalled();
    expect(mockFailWebhookEvent).toHaveBeenCalledWith(
      "evt_blip",
      expect.stringContaining("could not retrieve Stripe customer cus_abc"),
    );
    // The two categories are kept deliberately apart. A blip's durable record is
    // the unfinished ledger row above; the operator's queue is for failures a
    // retry will never fix, and filling it with 429s would bury the rows that
    // need a human.
    expect(failureWrites()).toEqual([]);
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

  it("returns 500 when a Stripe outbound call throws, so Stripe retries", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const event = buildEvent(
      "checkout.session.completed",
      { id: "cs_test_123", customer_email: "pay@example.com" },
      "evt_stripe_down",
    );
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveCheckoutSession.mockRejectedValue(new Error("stripe is down"));

    const res = await POST(buildRequest(JSON.stringify(event)));

    // D1: this used to be a 200, which told Stripe the event was handled and
    // stopped the retry that would have recovered the payment.
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ received: false, error: "Webhook handling failed" });
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
    expect(mockFailWebhookEvent).toHaveBeenCalledWith("evt_stripe_down", "stripe is down");
    expect(mockCompleteWebhookEvent).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
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

  it("never swallows a cancellation: a transient lookup failure is a 500, not a lost lock", async () => {
    const event = buildEvent(
      "customer.subscription.deleted",
      { id: "sub_gone", customer: "cus_gone" },
      "evt_deleted_blip",
    );
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveCustomer.mockRejectedValue(new Error("Stripe 503"));

    const res = await POST(buildRequest(JSON.stringify(event)));

    // A1's motivating scenario. The old handler returned 200 here, marked the
    // event complete, absorbed every redelivery as a duplicate and never armed a
    // lock, so the cancellation vanished and the customer kept free access with
    // nothing anywhere recording why.
    expect(res.status).toBe(500);
    expect(mockCompleteWebhookEvent).not.toHaveBeenCalled();
    expect(mockFailWebhookEvent).toHaveBeenCalledWith(
      "evt_deleted_blip",
      expect.stringContaining("could not retrieve Stripe customer cus_gone"),
    );
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
  it("returns 200 duplicate:true and skips processing for a COMPLETED event ID", async () => {
    const event = buildSubscriptionEvent("customer.subscription.updated", "active", "price_pro_monthly");
    event.id = "evt_duplicate_001";
    mockConstructEvent.mockReturnValue(event);
    mockClaimWebhookEvent.mockResolvedValue("completed");

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: true });
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
    expect(mockRetrieveCustomer).not.toHaveBeenCalled();
    // The short-circuit must not rewrite the ledger entry either.
    expect(mockCompleteWebhookEvent).not.toHaveBeenCalled();
    expect(mockFailWebhookEvent).not.toHaveBeenCalled();
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
    event.id = "evt_fail_open";
    mockConstructEvent.mockReturnValue(event);
    mockClaimWebhookEvent.mockResolvedValue("unknown");

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(mockCrossServiceFetch).toHaveBeenCalledTimes(1);
    // The completion write is the ledger's last chance to record the event when
    // the claim itself could not be written.
    expect(mockCompleteWebhookEvent).toHaveBeenCalledWith("evt_fail_open");
  });
});

describe("POST /api/billing/webhook — failure recovery (D1)", () => {
  it("leaves a failed event unfinished and reprocesses it when redelivered", async () => {
    const event = buildEvent(
      "checkout.session.completed",
      { id: "cs_test_123", customer_email: "pay@example.com" },
      "evt_redelivered",
    );
    mockConstructEvent.mockReturnValue(event);
    // Both deliveries see the same ledger row: claimed, processed_at NULL.
    mockClaimWebhookEvent.mockResolvedValue("claimed");

    mockRetrieveCheckoutSession.mockRejectedValueOnce(new Error("stripe is down"));
    const first = await POST(buildRequest(JSON.stringify(event)));

    expect(first.status).toBe(500);
    expect(mockCompleteWebhookEvent).not.toHaveBeenCalled();
    expect(mockFailWebhookEvent).toHaveBeenCalledWith("evt_redelivered", "stripe is down");

    // Stripe's redelivery must be allowed to finish the work rather than being
    // absorbed as a duplicate by the unfinished claim row.
    mockRetrieveCheckoutSession.mockResolvedValue(buildCheckoutSession());
    const second = await POST(buildRequest(JSON.stringify(event)));

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true });
    expect(syncPaths()).toEqual(["/api/provision", "/api/service/tier-sync"]);
    expect(mockCompleteWebhookEvent).toHaveBeenCalledWith("evt_redelivered");
    expect(mockClaimWebhookEvent).toHaveBeenCalledTimes(2);
  });

  it("records completion only after the handler ran to completion", async () => {
    const event = buildEvent(
      "checkout.session.completed",
      { id: "cs_test_123", customer_email: "pay@example.com" },
      "evt_completes",
    );
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveCheckoutSession.mockResolvedValue(buildCheckoutSession());

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(mockCompleteWebhookEvent).toHaveBeenCalledWith("evt_completes");
    expect(mockFailWebhookEvent).not.toHaveBeenCalled();
  });

  it("still returns 500 when the idempotency store is unavailable and handling then fails", async () => {
    const event = buildEvent(
      "checkout.session.completed",
      { id: "cs_test_123", customer_email: "pay@example.com" },
      "evt_fail_open_throw",
    );
    mockConstructEvent.mockReturnValue(event);
    mockClaimWebhookEvent.mockResolvedValue("unknown");
    mockRetrieveCheckoutSession.mockRejectedValue(new Error("stripe is down"));

    const res = await POST(buildRequest(JSON.stringify(event)));

    // Fail-open is about the ledger, never about the delivery contract.
    expect(res.status).toBe(500);
    expect(mockCompleteWebhookEvent).not.toHaveBeenCalled();
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
    const event = buildEvent("charge.succeeded", { id: "ch_123" }, "evt_ignored");
    mockConstructEvent.mockReturnValue(event);

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
    // An intentionally ignored type must still be marked completed, otherwise
    // every redelivery of it would be reprocessed forever.
    expect(mockCompleteWebhookEvent).toHaveBeenCalledWith("evt_ignored");
    expect(mockFailWebhookEvent).not.toHaveBeenCalled();
  });
});

describe("POST /api/billing/webhook — durable subscription record", () => {
  function checkoutEvent() {
    const event = buildEvent("checkout.session.completed", {
      id: "cs_test_123",
      customer_email: "pay@example.com",
      customer: "cus_abc",
    });
    mockConstructEvent.mockReturnValue(event);
    return event;
  }

  it("records the subscription behind a completed checkout, with the validated hub user id", async () => {
    const event = checkoutEvent();
    mockRetrieveCheckoutSession.mockResolvedValue(buildCheckoutSession());

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(subscriptionWrites()).toHaveLength(1);
    expect(subscriptionWrites()[0].op).toBe("insert");
    expect(subscriptionWrites()[0].payload).toMatchObject({
      user_id: "user_abc",
      email: "pay@example.com",
      stripe_customer_id: "cus_abc",
      stripe_subscription_id: "sub_abc",
      price_id: "price_pro_monthly",
      plan: "pro",
      interval: "month",
      status: "trialing",
      stripe_status: "trialing",
      cancel_at_period_end: false,
      current_period_end: new Date(PERIOD_END * 1000).toISOString(),
      trial_ends_at: new Date(TRIAL_END * 1000).toISOString(),
      source: "stripe",
    });
  });

  it("records the mapped status, plan and period end for a subscription update", async () => {
    const event = buildSubscriptionEvent("customer.subscription.updated", "past_due", "price_team_monthly", {
      metadata: { userId: "user_abc" },
      current_period_end: PERIOD_END,
    });
    mockConstructEvent.mockReturnValue(event);

    await POST(buildRequest(JSON.stringify(event)));

    expect(subscriptionWrites()).toHaveLength(1);
    expect(subscriptionWrites()[0].payload).toMatchObject({
      user_id: "user_abc",
      email: "pay@example.com",
      plan: "team",
      status: "past_due",
      stripe_status: "past_due",
      interval: "month",
      current_period_end: new Date(PERIOD_END * 1000).toISOString(),
    });
  });

  it("records free/canceled for a deleted subscription", async () => {
    const event = buildEvent("customer.subscription.deleted", {
      id: "sub_del",
      status: "canceled",
      customer: "cus_del",
      customer_email: "cancel@example.com",
    });
    mockConstructEvent.mockReturnValue(event);

    await POST(buildRequest(JSON.stringify(event)));

    expect(subscriptionWrites()[0].payload).toMatchObject({
      stripe_subscription_id: "sub_del",
      plan: "free",
      status: "canceled",
    });
  });

  it("stores NULL rather than a marketplace cuid in metadata.userId", async () => {
    // The marketplace writes its own Prisma cuid into the same Stripe account's
    // metadata.userId. Storing it would attach the row to a user that does not
    // exist and break every downstream read.
    const event = buildSubscriptionEvent("customer.subscription.updated", "active", "price_pro_monthly", {
      metadata: { userId: "clx8marketplacecuid" },
    });
    mockConstructEvent.mockReturnValue(event);

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(mockGetUserById).toHaveBeenCalledWith("clx8marketplacecuid");
    expect(subscriptionWrites()).toHaveLength(1);
    expect(subscriptionWrites()[0].payload.user_id).toBeNull();
    expect(subscriptionWrites()[0].payload.email).toBe("pay@example.com");
  });

  it("prefers the hub's own session metadata over a customer-object candidate", async () => {
    // No customer_email on the payload, so the outbound retrieve happens and the
    // customer's (marketplace) metadata.userId becomes a second candidate.
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
      metadata: { userId: "clx8marketplacecuid" },
    });

    await POST(buildRequest(JSON.stringify(event)));

    expect(mockRetrieveCustomer).toHaveBeenCalledWith("cus_abc");
    expect(subscriptionWrites()[0].payload.user_id).toBe("user_abc");
    expect(subscriptionWrites()[0].payload.email).toBe("outbound@example.com");
  });

  it("never writes over a manual operator grant", async () => {
    probeRow = { id: "row-manual", source: "manual", updated_at: "2026-09-01T00:00:00.000Z" };
    const event = buildSubscriptionEvent("customer.subscription.updated", "active", "price_pro_monthly");
    mockConstructEvent.mockReturnValue(event);

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(dbWritesFor("billing_subscriptions")).toHaveLength(0);
    expect(mockCompleteWebhookEvent).toHaveBeenCalled();
  });

  it("still answers 200 when the durable record write fails (a ledger, not a gate)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeError = { message: "42501 permission denied for table billing_subscriptions" };
    const event = buildSubscriptionEvent("customer.subscription.updated", "active", "price_pro_monthly");
    mockConstructEvent.mockReturnValue(event);

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    const logged = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(logged.some((message) => message.includes("Durable subscription record NOT written"))).toBe(true);
    // The globe was still told the tier: only the ledger failed.
    expect(mockCrossServiceFetch).toHaveBeenCalledTimes(1);
  });

  it("leaves the ledger untouched when the event carries no subscription object", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const event = buildEvent("invoice.payment_failed", {
      customer: "cus_fail",
      customer_email: "fail@example.com",
      subscription: "sub_fail",
    });
    mockConstructEvent.mockReturnValue(event);
    mockRetrieveSubscription.mockRejectedValue(new Error("network"));

    const res = await POST(buildRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    // A guessed plan would overwrite a real one, so nothing is written at all.
    expect(dbWritesFor("billing_subscriptions")).toHaveLength(0);
    expect(warnSpy.mock.calls.map((call) => String(call[0])).some((m) => m.includes("durable record left untouched"))).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
