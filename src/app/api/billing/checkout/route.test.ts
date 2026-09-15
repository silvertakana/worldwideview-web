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
  mockSessionsCreate,
  mockGetUser,
  mockIsBillingPaused,
} = vi.hoisted(() => ({
  mockGetStripe: vi.fn(),
  mockCustomersSearch: vi.fn(),
  mockCustomersCreate: vi.fn(),
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
  mockSessionsCreate.mockReset();
  mockGetUser.mockReset();
  mockIsBillingPaused.mockReset();

  mockGetUser.mockResolvedValue({
    data: { user: { id: "user_1", email: "pay@example.com" } },
  });
  mockGetStripe.mockReturnValue({
    customers: { search: mockCustomersSearch, create: mockCustomersCreate },
    checkout: { sessions: { create: mockSessionsCreate } },
  });
  mockCustomersSearch.mockResolvedValue({ data: [{ id: "cus_existing" }] });
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
