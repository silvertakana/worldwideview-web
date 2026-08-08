import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted setup — runs before module imports ────────────────────
// crossServiceFetch is mocked, but the env vars are set for parity with the
// webhook suite and to avoid surprises if a transitively imported module reads
// them. NEXT_PUBLIC_INSTANCE_URL_PATTERN is read at request time; most tests
// rely on it being set (matching production), one test clears it explicitly.
vi.hoisted(() => {
  process.env.PROVISIONING_API_URL = "https://globe.test:3443";
  process.env.CROSS_SERVICE_SECRET = "test-cross-service-secret";
  process.env.NEXT_PUBLIC_INSTANCE_URL_PATTERN = "https://{subdomain}.wwv.local";
});

const {
  mockGetUser,
  mockHasInstanceEntitlement,
  mockGetHighestTier,
  mockMarkEntitlementUsed,
  mockCrossServiceFetch,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockHasInstanceEntitlement: vi.fn(),
  mockGetHighestTier: vi.fn(),
  mockMarkEntitlementUsed: vi.fn(),
  mockCrossServiceFetch: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
  }),
}));

vi.mock("@/lib/cross-service/fetch", () => ({
  crossServiceFetch: mockCrossServiceFetch,
}));

// The real entitlements module boots a Supabase admin client; module-mocking
// keeps the auth + entitlement decision logic of the route under test without
// any DB dependency (same approach as tier-fallback.test.ts).
vi.mock("@/lib/auth/entitlements", () => ({
  hasInstanceEntitlement: mockHasInstanceEntitlement,
  getHighestTier: mockGetHighestTier,
  markEntitlementUsed: mockMarkEntitlementUsed,
}));

import { GET, POST } from "./route";

// ── Helpers ───────────────────────────────────────────────────────

const USER = { id: "user_abc", email: "pay@example.com" };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildRequest(body: string | unknown | undefined, method = "POST") {
  return new Request("https://wwv.local:3001/api/provisioning/instance", {
    method,
    body: typeof body === "string" ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function provisionCall(index: number) {
  return mockCrossServiceFetch.mock.calls[index][1];
}

// ── Setup ─────────────────────────────────────────────────────────

beforeEach(() => {
  mockGetUser.mockReset();
  mockHasInstanceEntitlement.mockReset();
  mockGetHighestTier.mockReset();
  mockMarkEntitlementUsed.mockReset();
  mockCrossServiceFetch.mockReset();

  // Defaults: authenticated user, entitled, highest tier pro. Each test
  // overrides what it needs; an unconfigured test fails via its assertions.
  mockGetUser.mockResolvedValue({ data: { user: USER } });
  mockHasInstanceEntitlement.mockResolvedValue(true);
  mockGetHighestTier.mockResolvedValue("pro");
  mockMarkEntitlementUsed.mockResolvedValue(undefined);

  // The route logs heavily at every step; silence it so the suite output
  // stays readable. Tests that assert on logs override the spy per-test.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────

describe("GET /api/provisioning/instance — auth-gated globe proxy", () => {
  it("proxies the globe instance list for the authenticated user", async () => {
    const instances = [
      { id: "i1", subdomain: "acme", name: "Acme", status: "active" },
    ];
    mockCrossServiceFetch.mockResolvedValue(jsonResponse({ instances }));

    const res = await GET();

    expect(mockCrossServiceFetch).toHaveBeenCalledTimes(1);
    expect(mockCrossServiceFetch.mock.calls[0][0]).toBe("/api/instance");
    expect(mockCrossServiceFetch.mock.calls[0][1]).toEqual({
      searchParams: { userId: "user_abc", email: "pay@example.com" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ instances });
  });

  it("returns 401 Unauthorized without calling the globe when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const res = await GET();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
  });

  it("falls back to an empty workspace list when the globe returns non-JSON", async () => {
    mockCrossServiceFetch.mockResolvedValue(new Response("", { status: 500 }));

    const res = await GET();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ workspaces: [] });
  });
});

describe("POST /api/provisioning/instance — instance creation", () => {
  it("provisions the user, creates the globe instance, marks entitlement used, and returns a setup URL", async () => {
    mockCrossServiceFetch
      .mockResolvedValueOnce(jsonResponse({ setupToken: "tok_123" }))
      .mockResolvedValueOnce(jsonResponse({ subdomain: "acme", name: "Acme" }));

    const res = await POST(buildRequest({ subdomain: "acme", name: "Acme" }));

    expect(mockCrossServiceFetch).toHaveBeenCalledTimes(2);
    expect(mockCrossServiceFetch.mock.calls[0][0]).toBe("/api/provision");
    expect(provisionCall(0)).toEqual({
      method: "POST",
      body: { email: "pay@example.com", name: "Acme", hubUserId: "user_abc" },
    });
    expect(mockCrossServiceFetch.mock.calls[1][0]).toBe("/api/instance");
    expect(provisionCall(1)).toEqual({
      method: "POST",
      body: {
        subdomain: "acme",
        name: "Acme",
        userId: "user_abc",
        email: "pay@example.com",
        tier: "pro",
      },
    });
    expect(mockMarkEntitlementUsed).toHaveBeenCalledWith("user_abc");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      subdomain: "acme",
      name: "Acme",
      setupUrl: "https://acme.wwv.local/setup?token=tok_123",
    });
  });

  it("derives the display name from the email local-part when name is omitted", async () => {
    mockCrossServiceFetch
      .mockResolvedValueOnce(jsonResponse({ setupToken: "tok_123" }))
      .mockResolvedValueOnce(jsonResponse({ subdomain: "acme" }));

    await POST(buildRequest({ subdomain: "acme" }));

    expect(provisionCall(0).body.name).toBe("pay");
    expect(provisionCall(1).body.name).toBeUndefined();
  });

  it("returns 400 when the subdomain is missing, without any globe call", async () => {
    const res = await POST(buildRequest({ name: "Acme" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "subdomain is required" });
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
    expect(mockMarkEntitlementUsed).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid JSON body", async () => {
    const res = await POST(buildRequest("{not-json"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
  });

  it("returns 403 when the user has no active entitlement, without any globe call", async () => {
    mockHasInstanceEntitlement.mockResolvedValue(false);

    const res = await POST(buildRequest({ subdomain: "acme" }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "No active entitlement. Redeem an access code at /accounts/redeem.",
    });
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
    expect(mockMarkEntitlementUsed).not.toHaveBeenCalled();
  });

  it("tolerates a 409 from provision (already provisioned) and still creates the instance", async () => {
    mockCrossServiceFetch
      .mockResolvedValueOnce(jsonResponse({ error: "already provisioned" }, 409))
      .mockResolvedValueOnce(jsonResponse({ subdomain: "acme" }));

    const res = await POST(buildRequest({ subdomain: "acme" }));

    expect(mockCrossServiceFetch).toHaveBeenCalledTimes(2);
    expect(mockMarkEntitlementUsed).toHaveBeenCalledWith("user_abc");
    expect(res.status).toBe(200);
    // No provision token available → setup URL built from the pattern only.
    expect(await res.json()).toEqual({
      subdomain: "acme",
      setupUrl: "https://acme.wwv.local",
    });
  });

  it("passes through the globe 409 duplicate-subdomain error and does not mark entitlement used", async () => {
    mockCrossServiceFetch
      .mockResolvedValueOnce(jsonResponse({ setupToken: "tok_123" }))
      .mockResolvedValueOnce(jsonResponse({ error: "Subdomain already taken" }, 409));

    const res = await POST(buildRequest({ subdomain: "acme" }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Subdomain already taken" });
    expect(mockMarkEntitlementUsed).not.toHaveBeenCalled();
  });

  it("returns 502 when the globe instance call throws a network error", async () => {
    mockCrossServiceFetch
      .mockResolvedValueOnce(jsonResponse({ setupToken: "tok_123" }))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await POST(buildRequest({ subdomain: "acme" }));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "Cannot reach globe service. Please try again.",
    });
    expect(mockMarkEntitlementUsed).not.toHaveBeenCalled();
  });

  it("returns the generic provisioning error when the globe responds non-JSON with a failure status", async () => {
    mockCrossServiceFetch
      .mockResolvedValueOnce(jsonResponse({ setupToken: "tok_123" }))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));

    const res = await POST(buildRequest({ subdomain: "acme" }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Provisioning service error" });
    expect(mockMarkEntitlementUsed).not.toHaveBeenCalled();
  });

  it("omits the setup URL when NEXT_PUBLIC_INSTANCE_URL_PATTERN is unset", async () => {
    delete process.env.NEXT_PUBLIC_INSTANCE_URL_PATTERN;
    mockCrossServiceFetch
      .mockResolvedValueOnce(jsonResponse({ setupToken: "tok_123" }))
      .mockResolvedValueOnce(jsonResponse({ subdomain: "acme" }));

    try {
      const res = await POST(buildRequest({ subdomain: "acme" }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.subdomain).toBe("acme");
      expect(body.setupUrl).toBeUndefined();
    } finally {
      process.env.NEXT_PUBLIC_INSTANCE_URL_PATTERN = "https://{subdomain}.wwv.local";
    }
  });
});

