import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted setup — runs before module imports ────────────────────
// crossServiceFetch is mocked, but the env vars are set for parity with the
// webhook suite and to avoid surprises if a transitively imported module reads
// them.
vi.hoisted(() => {
  process.env.PROVISIONING_API_URL = "https://globe.test:3443";
  process.env.CROSS_SERVICE_SECRET = "test-cross-service-secret";
});

const {
  mockGetUser,
  mockResolveCloudAccess,
  mockCrossServiceFetch,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockResolveCloudAccess: vi.fn(),
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

// The access decision itself is cloud-access.test.ts's subject, where it runs
// for real against stubbed stores. Here it is a boundary: what matters is that
// the route relays this authority's tier, plan, limit and source instead of
// deriving them from the access-code table. NO_ACCESS_MESSAGE is duplicated as
// a literal on purpose; cloud-access.test.ts pins it against the real module,
// so a copy change fails there rather than silently passing here.
vi.mock("@/lib/billing/cloud-access", () => ({
  NO_ACCESS_MESSAGE: "No active plan. Choose a plan at /pricing to create your workspace.",
  resolveCloudAccess: mockResolveCloudAccess,
}));

import { GET, POST } from "./route";
import type { AccessSource, CloudAccess } from "@/lib/billing/cloud-access";

// ── Helpers ───────────────────────────────────────────────────────

const USER = { id: "user_abc", email: "pay@example.com" };

function access(overrides: Partial<CloudAccess> = {}): CloudAccess {
  return {
    allowed: true,
    source: "subscription",
    tier: "pro",
    plan: "pro",
    instanceLimit: null,
    tiers: { subscription: "pro", override: null, "legacy-code": null },
    errors: {},
    ...overrides,
  };
}

function deniedAccess(): CloudAccess {
  return access({
    allowed: false,
    source: "none",
    tier: "free",
    plan: "local",
    instanceLimit: 0,
    tiers: { subscription: null, override: null, "legacy-code": null },
  });
}

/** What the authority decides for a tier, so the route's relay can be checked. */
const ACCOUNT_CASES: Array<[string, number | null, string, boolean, AccessSource]> = [
  ["free", 0, "local", false, "none"],
  ["beta_tester", 1, "beta_tester", true, "legacy-code"],
  ["early_access", 3, "early_access", true, "legacy-code"],
  ["pro", null, "pro", true, "subscription"],
  ["enterprise", null, "enterprise", true, "override"],
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildRequest(body: string | unknown | undefined, method = "POST") {
  return new Request("https://wwv.local:3001/api/provisioning/workspace", {
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
  mockResolveCloudAccess.mockReset();
  mockCrossServiceFetch.mockReset();

  // Defaults: authenticated user, paid access. Each test overrides what it
  // needs; an unconfigured test fails via its assertions.
  mockGetUser.mockResolvedValue({ data: { user: USER } });
  mockResolveCloudAccess.mockResolvedValue(access());

  // Silence the route's console output so the suite stays readable.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────

describe("GET /api/provisioning/workspace — workspace list with tier limits", () => {
  it.each(ACCOUNT_CASES)(
    "relays %s as instanceLimit %s, plan %s, accessActive %s (source %s)",
    async (tier, limit, plan, allowed, source) => {
      mockResolveCloudAccess.mockResolvedValue(
        access({ tier, plan, instanceLimit: limit, allowed, source }),
      );
      mockCrossServiceFetch.mockResolvedValue(
        jsonResponse({
          instances: [
            { id: "i1", subdomain: "acme", name: "Acme", status: "active", createdAt: "2026-01-01" },
          ],
        }),
      );

      const res = await GET();

      expect(mockResolveCloudAccess).toHaveBeenCalledWith({
        userId: "user_abc",
        email: "pay@example.com",
      });
      expect(mockCrossServiceFetch).toHaveBeenCalledTimes(1);
      expect(mockCrossServiceFetch.mock.calls[0][0]).toBe("/api/instance");
      expect(mockCrossServiceFetch.mock.calls[0][1]).toEqual({
        searchParams: { userId: "user_abc", email: "pay@example.com" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        workspaces: [
          { id: "i1", subdomain: "acme", name: "Acme", status: "active", createdAt: "2026-01-01" },
        ],
        account: {
          tier,
          plan,
          status: "active",
          trialEndsAt: null,
          instanceCount: 1,
          instanceLimit: limit,
          isTrialing: false,
          trialDaysRemaining: null,
          accessActive: allowed,
          accessSource: source,
        },
      });
    },
  );

  it("returns an empty workspace list with zero instanceCount when the globe has no instances", async () => {
    mockCrossServiceFetch.mockResolvedValue(jsonResponse({ instances: [] }));

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaces).toEqual([]);
    expect(body.account.instanceCount).toBe(0);
    expect(body.account.instanceLimit).toBeNull();
  });

  it("returns 401 Unauthorized without calling the globe when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const res = await GET();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
  });
});

describe("POST /api/provisioning/workspace — workspace provisioning", () => {
  it("provisions a workspace and returns the setup URL and token", async () => {
    mockCrossServiceFetch.mockResolvedValue(
      jsonResponse({
        setupUrl: "https://acme.wwv.local/setup?token=tok_123",
        setupToken: "tok_123",
      }),
    );

    const res = await POST(buildRequest({ subdomain: "acme", name: "Acme" }));

    expect(mockCrossServiceFetch).toHaveBeenCalledTimes(1);
    expect(mockCrossServiceFetch.mock.calls[0][0]).toBe("/api/provision");
    expect(provisionCall(0)).toEqual({
      method: "POST",
      body: {
        email: "pay@example.com",
        name: "Acme",
        hubUserId: "user_abc",
        subdomain: "acme",
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      setupUrl: "https://acme.wwv.local/setup?token=tok_123",
      setupToken: "tok_123",
    });
  });

  it("defaults the name to the full email when name is omitted", async () => {
    mockCrossServiceFetch.mockResolvedValue(jsonResponse({ setupUrl: "https://acme.wwv.local", setupToken: "tok_123" }));

    await POST(buildRequest({ subdomain: "acme" }));

    expect(provisionCall(0).body.name).toBe("pay@example.com");
  });

  it("returns 400 when the subdomain is missing, without any globe call", async () => {
    const res = await POST(buildRequest({ name: "Acme" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "subdomain is required" });
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid JSON body", async () => {
    const res = await POST(buildRequest("{not-json"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
  });

  it("returns 401 Unauthorized without calling the globe when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const res = await POST(buildRequest({ subdomain: "acme" }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
  });

  it("returns 403 pointing at the plans page when the account has no cloud access", async () => {
    mockResolveCloudAccess.mockResolvedValue(deniedAccess());

    const res = await POST(buildRequest({ subdomain: "acme" }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "No active plan. Choose a plan at /pricing to create your workspace.",
    });
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
  });

  it("proxies a non-ok provision response with the globe error body", async () => {
    mockCrossServiceFetch.mockResolvedValue(jsonResponse({ error: "something failed" }, 409));

    const res = await POST(buildRequest({ subdomain: "acme" }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "something failed" });
  });

  it("falls back to the generic provisioning error when the globe responds non-JSON with a failure status", async () => {
    mockCrossServiceFetch.mockResolvedValue(new Response("boom", { status: 500 }));

    const res = await POST(buildRequest({ subdomain: "acme" }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Provisioning service error" });
  });
});
