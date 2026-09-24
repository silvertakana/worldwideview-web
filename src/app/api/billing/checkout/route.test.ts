import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted setup — runs before module imports ────────────────────
// The real `getPriceId` (src/lib/billing/constants.ts) builds its PRICE_ID_MAP
// from these env vars at import time, so they must exist before the module
// graph loads. Using the real resolver (not a mock) exercises the actual
// price-id lookup.
vi.hoisted(() => {
  process.env.STRIPE_PRO_PRICE_ID = "price_pro_monthly";
  process.env.STRIPE_PRO_ANNUAL_PRICE_ID = "price_pro_yearly";
  process.env.STRIPE_TEAM_MONTHLY_PRICE_ID = "price_team_monthly";
  process.env.STRIPE_TEAM_ANNUAL_PRICE_ID = "price_team_yearly";
});

const {
  mockGetStripe,
  mockCustomersSearch,
  mockCustomersCreate,
  mockCustomersList,
  mockCustomersUpdate,
  mockSessionsCreate,
  mockGetUser,
  mockIsBillingPaused,
} = vi.hoisted(() => ({
  mockGetStripe: vi.fn(),
  mockCustomersSearch: vi.fn(),
  mockCustomersCreate: vi.fn(),
  mockCustomersList: vi.fn(),
  mockCustomersUpdate: vi.fn(),
  mockSessionsCreate: vi.fn(),
  mockGetUser: vi.fn(),
  mockIsBillingPaused: vi.fn(),
}));

// getStripe is the seam under test: asserting on it (rather than only on its
// methods) is the strongest form of "the paused route cannot reach Stripe" —
// while paused the client is never even constructed.
vi.mock("@/lib/stripe/client", () => ({
  getStripe: mockGetStripe,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
  }),
}));

// The route's only kill-switch seam. The real module reads the database through
// the server-only admin client, which does not run under jsdom.
vi.mock("@/lib/billing/kill-switch", () => ({
  isBillingPaused: mockIsBillingPaused,
  invalidateBillingKillSwitchCache: vi.fn(),
  KILL_SWITCH_CACHE_TTL_MS: 10_000,
}));

import { POST } from "./route";
import { BILLING_PAUSED_MESSAGE } from "@/lib/billing/constants";

// ── Helpers ───────────────────────────────────────────────────────

function buildRequest(body = JSON.stringify({ plan: "pro" })) {
  return new Request("https://wwv.local:3001/api/billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ── Setup ─────────────────────────────────────────────────────────

beforeEach(() => {
  mockGetStripe.mockReset();
  mockCustomersSearch.mockReset();
  mockCustomersCreate.mockReset();
  mockCustomersList.mockReset();
  mockCustomersUpdate.mockReset();
  mockSessionsCreate.mockReset();
  mockGetUser.mockReset();
  mockIsBillingPaused.mockReset();

  mockGetUser.mockResolvedValue({
    data: { user: { id: "user_1", email: "pay@example.com" } },
  });
  mockGetStripe.mockReturnValue({
    customers: {
      search: mockCustomersSearch,
      create: mockCustomersCreate,
      list: mockCustomersList,
      update: mockCustomersUpdate,
    },
    checkout: { sessions: { create: mockSessionsCreate } },
  });
  mockCustomersSearch.mockResolvedValue({ data: [{ id: "cus_existing" }] });
  // Default: the email fallback finds nobody, so the metadata-search hit above
  // is what every pre-existing test in this file still exercises.
  mockCustomersList.mockResolvedValue({ data: [] });
  mockCustomersUpdate.mockResolvedValue({ id: "cus_thankyou" });
  mockSessionsCreate.mockResolvedValue({ url: "https://checkout.stripe.test/cs_1" });

  // Default verdict for this suite: billing is live.
  mockIsBillingPaused.mockResolvedValue({ paused: false, source: "database" });
});

// ── Tests ─────────────────────────────────────────────────────────
//
// ANTI-VACUITY: the 503 assertions below are designed so that reverting ONLY
// src/app/api/billing/checkout/route.ts to its pre-kill-switch version makes
// them FAIL. With the old route, `isBillingPaused` is never consulted, the
// route proceeds past the pause, and it answers 200 with a checkout url — so
// both `expect(res.status).toBe(503)` and `expect(mockGetStripe).not.toHaveBeenCalled()`
// break. The suite cannot pass against the un-gated route.

describe("POST /api/billing/checkout — runtime kill switch", () => {
  it("answers 503 and never constructs the Stripe client while paused (anti-vacuity)", async () => {
    mockIsBillingPaused.mockResolvedValue({ paused: true, source: "database", reason: "incident-42" });

    const res = await POST(buildRequest());

    expect(res.status).toBe(503);
    // The strongest possible form of "no money can move": the Stripe client was
    // never built, so no Stripe API surface existed to call.
    expect(mockGetStripe).not.toHaveBeenCalled();
    expect(mockSessionsCreate).not.toHaveBeenCalled();
    expect(mockCustomersSearch).not.toHaveBeenCalled();
    expect(mockCustomersCreate).not.toHaveBeenCalled();
  });

  it("carries the operator-supplied reason for a database pause", async () => {
    mockIsBillingPaused.mockResolvedValue({ paused: true, source: "database", reason: "incident-42" });

    const res = await POST(buildRequest());
    const body = await bodyOf(res);

    expect(res.status).toBe(503);
    expect(body.error).toBe(BILLING_PAUSED_MESSAGE);
    expect(body.error).toBe("Billing is temporarily unavailable. Please try again later.");
    expect(body.paused).toBe(true);
    expect(body.source).toBe("database");
    expect(body.reason).toBe("incident-42");
  });

  it("omits `reason` entirely when the kill switch state is unavailable", async () => {
    mockIsBillingPaused.mockResolvedValue({ paused: true, source: "unavailable" });

    const res = await POST(buildRequest());
    const body = await bodyOf(res);

    expect(res.status).toBe(503);
    // A broken database read must not leak internal error text to a client.
    expect("reason" in body).toBe(false);
    expect(body.error).toBe(BILLING_PAUSED_MESSAGE);
    expect(body.source).toBe("unavailable");
  });

  it("reports source env when the environment variable engages the switch", async () => {
    mockIsBillingPaused.mockResolvedValue({ paused: true, source: "env", reason: "manual maintenance" });

    const res = await POST(buildRequest());
    const body = await bodyOf(res);

    expect(res.status).toBe(503);
    expect(body.source).toBe("env");
    expect(body.reason).toBe("manual maintenance");
    expect(mockGetStripe).not.toHaveBeenCalled();
  });

  it("regression guard: behaves exactly as before when billing is not paused", async () => {
    const res = await POST(buildRequest());
    const body = await bodyOf(res);

    expect(res.status).toBe(200);
    expect(body.url).toBe("https://checkout.stripe.test/cs_1");
    expect(mockCustomersSearch).toHaveBeenCalledTimes(1);
    expect(mockSessionsCreate).toHaveBeenCalledTimes(1);
    expect(mockSessionsCreate.mock.calls[0][0]).toMatchObject({
      mode: "subscription",
      customer: "cus_existing",
      line_items: [{ price: "price_pro_monthly", quantity: 1 }],
    });
  });
});

// ── Stripe API failure handling ─────────────────────────────────────
//
// ANTI-VACUITY: against the pre-guard route these tests FAIL before any
// assertion is evaluated — the thrown Stripe error propagates out of POST and
// rejects the awaited promise (Next.js would turn it into an empty-body 500),
// so `res.status` could never match. They cannot pass against an unguarded
// route, and they cannot pass by returning the old 200 either.

describe("POST /api/billing/checkout — Stripe API failure", () => {
  function stripeThrow(type: string, code?: string, param?: string): Error {
    // Stripe-shaped error without importing the SDK: the route detects it
    // structurally (type/code/param), mirroring the wire contract.
    const err = new Error(`Stripe ${type}${code ? ` (code ${code})` : ""}`);
    if (type) (err as { type?: string }).type = type;
    if (code) (err as { code?: string }).code = code;
    if (param) (err as { param?: string }).param = param;
    return err;
  }

  it("answers 429 with the Stripe error type when customers.search is rate limited", async () => {
    mockCustomersSearch.mockRejectedValue(stripeThrow("rate_limit_error"));

    const res = await POST(buildRequest());
    const body = await bodyOf(res);

    expect(res.status).toBe(429);
    expect(body.error).toBe("Billing is busy right now. Please try again in a moment.");
    expect(body.stripe_error).toEqual({ type: "rate_limit_error" });
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("answers 402 with type+code when the card is declined at session creation", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersCreate.mockResolvedValue({ id: "cus_new" });
    mockSessionsCreate.mockRejectedValue(stripeThrow("card_error", "insufficient_funds", "card"));

    const res = await POST(buildRequest());
    const body = await bodyOf(res);

    expect(res.status).toBe(402);
    expect(body.error).toBe(
      "Your payment method was declined. Please try another card or contact your bank.",
    );
    expect(body.stripe_error).toEqual({
      type: "card_error",
      code: "insufficient_funds",
      param: "card",
    });
    expect(mockCustomersCreate).toHaveBeenCalledTimes(1);
  });

  it("answers 502 with Stripe's type when customer creation is rejected as invalid request", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersCreate.mockRejectedValue(stripeThrow("invalid_request_error"));

    const res = await POST(buildRequest());
    const body = await bodyOf(res);

    expect(res.status).toBe(502);
    expect(body.error).toBe("Checkout could not be started. Please try again later.");
    expect(body.stripe_error).toEqual({ type: "invalid_request_error" });
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("answers 500 for a non-Stripe exception instead of exposing it as a Stripe failure", async () => {
    mockSessionsCreate.mockRejectedValue(new TypeError("cannot read properties of undefined"));

    const res = await POST(buildRequest());
    const body = await bodyOf(res);

    expect(res.status).toBe(500);
    expect(body.error).toBe("Checkout could not be started. Please try again later.");
    expect(body.stripe_error).toEqual({ type: "non_stripe_error" });
  });

  it("must always answer with parseable JSON: even an unknown shape keeps the contract", async () => {
    // Regression anchor for the CI-e2e breakage: resp.json() never sees an
    // empty body again, whatever the Stripe client throws.
    mockSessionsCreate.mockRejectedValue("a raw string, not an Error");

    const res = await POST(buildRequest());
    const body = await bodyOf(res);

    expect(res.status).toBe(500);
    expect(body.error).toBe("Checkout could not be started. Please try again later.");
    expect(body.stripe_error).toEqual({ type: "non_stripe_error" });
  });
});

// ── Personal promo codes ────────────────────────────────────────────
//
// The early-access buyers hold a customer-restricted 100%-off promo code. Two
// separate defects made those codes impossible to redeem, and each fix has its
// own assertion below so reverting either one fails a test instead of quietly
// re-breaking the code: with no `allow_promotion_codes` the hosted page rendered
// no code field at all, and with no email fallback the route billed a customer
// it had just created, which a customer-restricted code rejects with 400
// promotion_code_customer_mismatch.

const THANKYOU_CUSTOMER = {
  id: "cus_thankyou",
  email: "david@example.com",
  metadata: {
    wwv_cohort: "early-access-thankyou",
    wwv_first_name: "David",
    wwv_ticket: "T-42",
  },
};

function sessionParams(): Record<string, unknown> {
  return mockSessionsCreate.mock.calls[0][0] as Record<string, unknown>;
}

function subscriptionData(): Record<string, unknown> {
  return sessionParams().subscription_data as Record<string, unknown>;
}

describe("POST /api/billing/checkout — personal promo codes", () => {
  it("enables the hosted page's promotion-code field", async () => {
    await POST(buildRequest());

    expect(sessionParams().allow_promotion_codes).toBe(true);
    // Mutually exclusive with `allow_promotion_codes`; passing either would make
    // Stripe reject the session.
    expect("discounts" in sessionParams()).toBe(false);
    expect("discount" in sessionParams()).toBe(false);
  });

  it("bills the pre-created customer the email fallback finds, not a new one", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersList.mockResolvedValue({ data: [THANKYOU_CUSTOMER] });

    const res = await POST(buildRequest());

    expect(res.status).toBe(200);
    expect(mockCustomersList).toHaveBeenCalledWith({ email: "pay@example.com", limit: 10 });
    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(sessionParams().customer).toBe("cus_thankyou");
  });

  it("prefers the cohort record when the buyer owns more than one customer", async () => {
    // The trap stripe-ops found: customers.list is newest-first, so a buyer who
    // tried to check out before this fix owns an empty record created by the old
    // code. Taking data[0] would pick THAT one, and the customer-restricted code
    // would be refused exactly as before.
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersList.mockResolvedValue({
      data: [{ id: "cus_orphan", metadata: {} }, THANKYOU_CUSTOMER],
    });

    await POST(buildRequest());

    expect(sessionParams().customer).toBe("cus_thankyou");
    expect("trial_period_days" in subscriptionData()).toBe(false);
  });

  it("takes the newest record when no record carries the cohort tag", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersList.mockResolvedValue({
      data: [{ id: "cus_newest", metadata: {} }, { id: "cus_older", metadata: {} }],
    });

    await POST(buildRequest());

    // No cohort tag anywhere means no basis to prefer the older record, and the
    // newest is what the account email was last used with.
    expect(sessionParams().customer).toBe("cus_newest");
    expect(subscriptionData().trial_period_days).toBe(7);
  });

  it("adopts the customer it found, keeping the cohort tags it already carried", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersList.mockResolvedValue({ data: [THANKYOU_CUSTOMER] });

    await POST(buildRequest());

    // The point of the backfill is that the NEXT lookup hits on userId. A
    // metadata update REPLACES the object, so dropping wwv_cohort here would both
    // destroy the record and re-enable the trial for this cohort.
    expect(mockCustomersUpdate).toHaveBeenCalledWith("cus_thankyou", {
      metadata: {
        wwv_cohort: "early-access-thankyou",
        wwv_first_name: "David",
        wwv_ticket: "T-42",
        userId: "user_1",
      },
    });
  });

  it("leaves an already-adopted customer alone on a repeat checkout", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersList.mockResolvedValue({
      data: [{ ...THANKYOU_CUSTOMER, metadata: { ...THANKYOU_CUSTOMER.metadata, userId: "user_1" } }],
    });

    await POST(buildRequest());

    expect(mockCustomersUpdate).not.toHaveBeenCalled();
    expect(sessionParams().customer).toBe("cus_thankyou");
  });

  it("still creates a customer when neither the userId search nor the email matches", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersList.mockResolvedValue({ data: [] });
    mockCustomersCreate.mockResolvedValue({ id: "cus_new" });

    await POST(buildRequest());

    expect(mockCustomersCreate).toHaveBeenCalledWith({
      email: "pay@example.com",
      metadata: { userId: "user_1" },
    });
    expect(sessionParams().customer).toBe("cus_new");
  });

  it("never searches by email when the account has no email", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersCreate.mockResolvedValue({ id: "cus_new" });
    mockGetUser.mockResolvedValue({ data: { user: { id: "user_1", email: null } } });

    await POST(buildRequest());

    // customers.list takes an email; handing it undefined asks Stripe for every
    // customer in the account and bills whichever one came back first.
    expect(mockCustomersList).not.toHaveBeenCalled();
    expect(sessionParams().customer).toBe("cus_new");
  });

  it("gives the thank-you cohort NO trial, when found by email", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersList.mockResolvedValue({ data: [THANKYOU_CUSTOMER] });

    await POST(buildRequest());

    const sub = subscriptionData();
    // `in` rather than toBeUndefined(): the bug being guarded is a spread that
    // emits the key holding undefined, which toBeUndefined() would pass.
    expect("trial_period_days" in sub).toBe(false);
    expect(sub.metadata).toEqual({ userId: "user_1", plan: "pro", interval: "month" });
  });

  it("gives the thank-you cohort NO trial on a repeat checkout found by userId", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [THANKYOU_CUSTOMER] });

    await POST(buildRequest());

    expect("trial_period_days" in subscriptionData()).toBe(false);
  });

  it("keeps the 7-day trial for everyone else", async () => {
    mockCustomersSearch.mockResolvedValue({
      data: [{ id: "cus_existing", metadata: { userId: "user_1" } }],
    });

    await POST(buildRequest());

    expect(subscriptionData().trial_period_days).toBe(7);
  });

  it("keeps the 7-day trial for an email-matched customer with no cohort tag", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersList.mockResolvedValue({
      data: [{ id: "cus_public", metadata: { userId: "user_1" } }],
    });

    await POST(buildRequest());

    expect(subscriptionData().trial_period_days).toBe(7);
  });
});
