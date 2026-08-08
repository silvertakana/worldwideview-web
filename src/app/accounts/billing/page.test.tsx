import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// ── Hoisted mocks ─────────────────────────────────────────────────
const {
  mockGetUser,
  mockCrossServiceFetch,
  mockGetHubTierFallback,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockCrossServiceFetch: vi.fn(),
  mockGetHubTierFallback: vi.fn(),
}));

// The billing page is a Server Component: it awaits a dynamic import of the
// Supabase server client, calls crossServiceFetch against the globe tier
// endpoint, and falls back to getHubTierFallback when the globe has no org.
// All three are mocked; the tier mapping + banner/CTA logic under test is real.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
  }),
}));

vi.mock("@/lib/cross-service/fetch", () => ({
  crossServiceFetch: mockCrossServiceFetch,
}));

vi.mock("@/lib/billing/tier-fallback", () => ({
  getHubTierFallback: mockGetHubTierFallback,
}));

import BillingPage from "./page";

// ── Helpers ───────────────────────────────────────────────────────

const USER = { id: "user_abc", email: "pay@example.com" };

function globeResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PAID_TIER = { plan: "pro", status: "active", trialEndsAt: null, isTrialing: false };

// ── Setup ─────────────────────────────────────────────────────────

beforeEach(() => {
  mockGetUser.mockReset();
  mockCrossServiceFetch.mockReset();
  mockGetHubTierFallback.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: USER } });
});

// ── FIX 1: "Create your first instance" CTA ───────────────────────

describe("billing page — zero-instance CTA", () => {
  it("shows the CTA linking to /accounts/instances when the user has zero instances", async () => {
    mockCrossServiceFetch.mockResolvedValue(
      globeResponse({ tier: "pro", effectiveStatus: "active", instanceCount: 0, instanceLimit: 10, isTrialing: false }),
    );

    render(await BillingPage());

    const cta = screen.getByRole("link", { name: /create your first instance/i });
    expect(cta).toHaveAttribute("href", "/accounts/instances");
  });

  it("hides the CTA when the user already has instances", async () => {
    mockCrossServiceFetch.mockResolvedValue(
      globeResponse({ tier: "pro", effectiveStatus: "active", instanceCount: 2, instanceLimit: 10, isTrialing: false }),
    );

    render(await BillingPage());

    expect(screen.queryByRole("link", { name: /create your first instance/i })).toBeNull();
  });

  it("shows the CTA for free users with zero instances too", async () => {
    mockCrossServiceFetch.mockResolvedValue(
      globeResponse({ tier: "free", effectiveStatus: "active", instanceCount: 0, instanceLimit: 10, isTrialing: false }),
    );

    render(await BillingPage());

    expect(screen.getByRole("link", { name: /create your first instance/i })).toBeInTheDocument();
  });
});

// ── FIX 2b: setup-failure banner ──────────────────────────────────

describe("billing page — setup-failure banner", () => {
  it("shows the banner when paid but the globe org is missing (404) and zero instances", async () => {
    mockCrossServiceFetch.mockResolvedValue(new Response("", { status: 404 }));
    mockGetHubTierFallback.mockResolvedValue(PAID_TIER);

    render(await BillingPage());

    expect(screen.getByText(/account couldn't be fully set up/i)).toBeInTheDocument();
  });

  it("shows the banner when the globe is unreachable (transport error) and zero instances", async () => {
    mockCrossServiceFetch.mockRejectedValue(new Error("network down"));
    mockGetHubTierFallback.mockResolvedValue(PAID_TIER);

    render(await BillingPage());

    expect(screen.getByText(/account couldn't be fully set up/i)).toBeInTheDocument();
  });

  it("hides the banner when the globe confirms the org exists", async () => {
    mockCrossServiceFetch.mockResolvedValue(
      globeResponse({ tier: "pro", effectiveStatus: "active", instanceCount: 0, instanceLimit: 10, isTrialing: false }),
    );

    render(await BillingPage());

    expect(screen.queryByText(/account couldn't be fully set up/i)).toBeNull();
  });

  it("hides the banner for users without a paid tier (no fallback data)", async () => {
    mockCrossServiceFetch.mockResolvedValue(new Response("", { status: 404 }));
    mockGetHubTierFallback.mockResolvedValue(null);

    render(await BillingPage());

    expect(screen.queryByText(/account couldn't be fully set up/i)).toBeNull();
  });

  it("hides the banner for deleted accounts", async () => {
    mockCrossServiceFetch.mockResolvedValue(new Response("", { status: 404 }));
    mockGetHubTierFallback.mockResolvedValue({ plan: "pro", status: "deleted", trialEndsAt: null, isTrialing: false });

    render(await BillingPage());

    expect(screen.queryByText(/account couldn't be fully set up/i)).toBeNull();
  });
});
