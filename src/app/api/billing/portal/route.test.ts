import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted setup — runs before module imports ────────────────────

const {
  mockGetStripe,
  mockCustomersSearch,
  mockCustomersList,
  mockSubscriptionsList,
  mockPortalCreate,
  mockGetUser,
} = vi.hoisted(() => ({
  mockGetStripe: vi.fn(),
  mockCustomersSearch: vi.fn(),
  mockCustomersList: vi.fn(),
  mockSubscriptionsList: vi.fn(),
  mockPortalCreate: vi.fn(),
  mockGetUser: vi.fn(),
}));

vi.mock("@/lib/stripe/client", () => ({
  getStripe: mockGetStripe,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
  }),
}));

import { POST } from "./route";

// ── Helpers ───────────────────────────────────────────────────────

function buildRequest() {
  return new Request("https://wwv.local:3001/api/billing/portal", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function stripeThrow(type: string, code?: string, param?: string): Error {
  // Stripe-shaped error without importing the SDK: the route detects it
  // structurally (type/code/param), mirroring the wire contract.
  const err = new Error(`Stripe ${type}${code ? ` (code ${code})` : ""}`);
  if (type) (err as { type?: string }).type = type;
  if (code) (err as { code?: string }).code = code;
  if (param) (err as { param?: string }).param = param;
  return err;
}

// ── Setup ─────────────────────────────────────────────────────────

beforeEach(() => {
  mockGetStripe.mockReset();
  mockCustomersSearch.mockReset();
  mockCustomersList.mockReset();
  mockSubscriptionsList.mockReset();
  mockPortalCreate.mockReset();
  mockGetUser.mockReset();

  mockGetUser.mockResolvedValue({
    data: { user: { id: "user_1", email: "pay@example.com" } },
  });
  mockGetStripe.mockReturnValue({
    customers: { search: mockCustomersSearch, list: mockCustomersList },
    subscriptions: { list: mockSubscriptionsList },
    billingPortal: { sessions: { create: mockPortalCreate } },
  });
  mockCustomersSearch.mockResolvedValue({ data: [{ id: "cus_existing" }] });
  mockSubscriptionsList.mockResolvedValue({
    data: [{ status: "active" }],
  });
  mockPortalCreate.mockResolvedValue({
    url: "https://billing.stripe.test/portal_1",
  });
});

// ── Tests ─────────────────────────────────────────────────────────
//
// ANTI-VACUITY: against the pre-guard route these failure tests FAIL before any
// assertion is evaluated — the thrown Stripe error propagates out of POST and
// rejects the awaited promise (Next.js would turn it into an empty-body 500),
// so `res.status` could never match. They cannot pass against an unguarded
// route, and they cannot pass by returning the old 200 either.

describe("POST /api/billing/portal — Stripe API failure", () => {
  it("answers 429 with the Stripe error type when the customer search is rate limited", async () => {
    mockCustomersSearch.mockRejectedValue(stripeThrow("rate_limit_error"));

    const res = await POST(buildRequest());
    const body = await bodyOf(res);

    expect(res.status).toBe(429);
    expect(body.error).toBe("Billing is busy right now. Please try again in a moment.");
    expect(body.stripe_error).toEqual({ type: "rate_limit_error" });
    expect(mockSubscriptionsList).not.toHaveBeenCalled();
    expect(mockPortalCreate).not.toHaveBeenCalled();
  });

  it("answers 502 with Stripe's type when the email fallback lookup is rejected as invalid request", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersList.mockRejectedValue(stripeThrow("invalid_request_error"));

    const res = await POST(buildRequest());
    const body = await bodyOf(res);

    expect(res.status).toBe(502);
    expect(body.error).toBe("Could not open the billing portal. Please try again later.");
    expect(body.stripe_error).toEqual({ type: "invalid_request_error" });
    expect(mockSubscriptionsList).not.toHaveBeenCalled();
  });

  it("answers 502 with Stripe's type when the subscription lookup fails as an API error", async () => {
    mockSubscriptionsList.mockRejectedValue(stripeThrow("api_error"));

    const res = await POST(buildRequest());
    const body = await bodyOf(res);

    expect(res.status).toBe(502);
    expect(body.error).toBe("Could not open the billing portal. Please try again later.");
    expect(body.stripe_error).toEqual({ type: "api_error" });
    expect(mockPortalCreate).not.toHaveBeenCalled();
  });

  it("answers 402 with type+code when the portal session is rejected as a card error", async () => {
    mockPortalCreate.mockRejectedValue(
      stripeThrow("card_error", "insufficient_funds", "card"),
    );

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
    expect(mockCustomersSearch).toHaveBeenCalledTimes(1);
  });

  it("answers 500 for a non-Stripe exception instead of exposing it as a Stripe failure", async () => {
    mockPortalCreate.mockRejectedValue(
      new TypeError("cannot read properties of undefined"),
    );

    const res = await POST(buildRequest());
    const body = await bodyOf(res);

    expect(res.status).toBe(500);
    expect(body.error).toBe("Could not open the billing portal. Please try again later.");
    expect(body.stripe_error).toEqual({ type: "non_stripe_error" });
  });

  it("must always answer with parseable JSON: even an unknown shape keeps the contract", async () => {
    // Regression anchor for the checkout fix's CI-e2e breakage: resp.json()
    // never sees an empty body again, whatever the Stripe client throws.
    mockPortalCreate.mockRejectedValue("a raw string, not an Error");

    const res = await POST(buildRequest());
    const body = await bodyOf(res);

    expect(res.status).toBe(500);
    expect(body.error).toBe("Could not open the billing portal. Please try again later.");
    expect(body.stripe_error).toEqual({ type: "non_stripe_error" });
  });
});

describe("POST /api/billing/portal — behavior unchanged", () => {
  it("regression guard: success path answers exactly as before the guard", async () => {
    const res = await POST(buildRequest());
    const body = await bodyOf(res);

    expect(res.status).toBe(200);
    expect(body.url).toBe("https://billing.stripe.test/portal_1");
    expect(mockCustomersSearch).toHaveBeenCalledTimes(1);
    expect(mockPortalCreate).toHaveBeenCalledTimes(1);
    expect(mockPortalCreate.mock.calls[0][0]).toMatchObject({
      customer: "cus_existing",
      return_url: "https://wwv.local/accounts/billing",
    });
  });

  it("keeps the 404 no-customer guard ahead of any portal session creation", async () => {
    mockCustomersSearch.mockResolvedValue({ data: [] });
    mockCustomersList.mockResolvedValue({ data: [] });

    const res = await POST(buildRequest());
    const body = await bodyOf(res);

    expect(res.status).toBe(404);
    expect(body.error).toBe("No Stripe customer found for this account");
    expect(mockSubscriptionsList).not.toHaveBeenCalled();
    expect(mockPortalCreate).not.toHaveBeenCalled();
  });
});
