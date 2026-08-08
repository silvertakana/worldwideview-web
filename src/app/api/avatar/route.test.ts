import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";

// ── Hoisted setup — runs before module imports ────────────────────
// Mirror the provisioning instance route test: the supabase server module is
// mocked so getUser() can be driven per-test, and global fetch is stubbed so
// the server-side DiceBear proxy call is observable.
const { mockGetUser } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
  }),
}));

import { GET } from "./route";

// ── Fixtures ──────────────────────────────────────────────────────

const USER = {
  id: "user_abc",
  email: "quickverify@wwv.local",
  user_metadata: { name: "Quick Verify" },
};

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

let mockFetch: ReturnType<typeof vi.fn>;

// ── Setup ─────────────────────────────────────────────────────────

beforeEach(() => {
  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: USER } });

  // Default fetch stub: no upstream call is expected unless a test opts in.
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────

describe("GET /api/avatar — session-authenticated canonical avatar", () => {
  it("returns 401 Unauthorized without calling the upstream when there is no session", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const res = await GET();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("307-redirects to the custom avatar URL with Cache-Control: no-store", async () => {
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          ...USER,
          user_metadata: {
            name: "Quick Verify",
            avatar_url: "https://cdn.example.com/avatar.png",
          },
        },
      },
    });

    const res = await GET();

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://cdn.example.com/avatar.png");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("proxies a server-side DiceBear SVG seeded with the SHA-256 email hash, never the display name", async () => {
    mockFetch.mockResolvedValue(new Response(SVG, { status: 200 }));

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400, immutable");
    expect(await res.text()).toBe(SVG);

    // The upstream URL must carry the SHA-256 digest of the normalized email
    // as the seed — not the raw email, and not the display name.
    const expectedHash = createHash("sha256").update("quickverify@wwv.local").digest("hex");
    const calledUrl = String(mockFetch.mock.calls[0][0]);
    expect(calledUrl).toContain("https://api.dicebear.com/9.x/adventurer-neutral/svg");
    expect(calledUrl).toContain(`seed=${expectedHash}`);
    expect(calledUrl).not.toContain("quickverify@wwv.local");
    expect(calledUrl).not.toContain("Quick");
  });

  it("returns 502 with a JSON error when the upstream DiceBear fetch rejects", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await GET();

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Upstream avatar provider failed" });
  });

  it("returns 502 with a JSON error when the upstream DiceBear fetch responds non-OK", async () => {
    mockFetch.mockResolvedValue(new Response("rate limited", { status: 429 }));

    const res = await GET();

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Upstream avatar provider failed" });
  });
});
