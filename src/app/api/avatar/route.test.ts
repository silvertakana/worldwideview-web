import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted setup — runs before module imports ────────────────────
// Mirror the provisioning instance route test: the supabase server module is
// mocked so getUser() can be driven per-test. Global fetch is stubbed to
// THROW: the reworked route must never touch the network (offline generation
// only), so any accidental fetch fails the test loudly.
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

const SVG_DOC =
  "<svg xmlns='http://www.w3.org/2000/svg'><rect width='100' height='100'/></svg>";

// Stored data-URL avatars are utf8-encoded (svgToDataUrl / backfill script):
// `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`.
const DATA_AVATAR = `data:image/svg+xml;utf8,${encodeURIComponent(SVG_DOC)}`;

let mockFetch: ReturnType<typeof vi.fn>;

// ── Setup ─────────────────────────────────────────────────────────

beforeEach(() => {
  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: USER } });

  // No upstream call is expected anywhere in the reworked route. Stub fetch
  // to throw so a regression back to proxying fails the suite immediately.
  mockFetch = vi.fn(() => {
    throw new Error("offline violation: /api/avatar must not fetch");
  });
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

  it("307-redirects to an http/https custom avatar URL with Cache-Control: no-store", async () => {
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

  it("serves a data: custom avatar URL INLINE as the DECODED SVG body with immutable cache", async () => {
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          ...USER,
          user_metadata: {
            name: "Quick Verify",
            avatar_url: DATA_AVATAR,
          },
        },
      },
    });

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400, immutable");
    expect(res.headers.get("location")).toBeNull();
    // The body is the DECODED SVG document, never the raw data-URL string.
    const body = await res.text();
    expect(body).toBe(SVG_DOC);
    expect(body.startsWith("<svg")).toBe(true);
    expect(body).not.toBe(DATA_AVATAR);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("falls back to offline generation for a malformed data URL instead of serving garbage", async () => {
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          ...USER,
          user_metadata: {
            name: "Quick Verify",
            avatar_url: "data:image/svg+xml;utf8,not%20encoded%20svg",
          },
        },
      },
    });

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400, immutable");

    const body = await res.text();
    expect(body).toContain("<svg");
    expect(body).not.toContain("not encoded svg");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("generates an offline SVG seeded by the SHA-256 email hash — never the raw email or display name", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400, immutable");

    const body = await res.text();
    expect(body).toContain("<svg");
    expect(body).not.toContain("quickverify@wwv.local");
    expect(body).not.toContain("Quick");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("generates deterministically: the same email always yields the same SVG", async () => {
    const first = await GET();
    const second = await GET();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.text()).toBe(await second.text());
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
