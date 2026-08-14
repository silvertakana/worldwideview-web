import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────
const { mockGetUser, mockCrossServiceFetch } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
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

import { DELETE, GET, PATCH } from "./route";

// ── Helpers ───────────────────────────────────────────────────────

const USER = { id: "user_abc", email: "pay@example.com" };
const WORKSPACE_ID = "ws_123";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildRequest(
  overrides: { method?: string; body?: unknown } = {},
): Request {
  const { method = "DELETE", body } = overrides;
  return new Request(
    `https://wwv.local:3001/api/provisioning/workspace/${WORKSPACE_ID}`,
    {
      method,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
  );
}

// Next.js App Router passes params as a Promise in newer versions
const PARAMS = Promise.resolve({ id: WORKSPACE_ID });

// ── Setup ─────────────────────────────────────────────────────────

beforeEach(() => {
  mockGetUser.mockReset();
  mockCrossServiceFetch.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: USER } });
});

// ── Tests ─────────────────────────────────────────────────────────

describe("DELETE /api/provisioning/workspace/[id]", () => {
  it("proxies the globe DELETE and returns its response", async () => {
    mockCrossServiceFetch.mockResolvedValue(
      jsonResponse({ deleted: true }),
    );

    const res = await DELETE(buildRequest(), { params: PARAMS });

    expect(mockCrossServiceFetch).toHaveBeenCalledTimes(1);
    expect(mockCrossServiceFetch.mock.calls[0][0]).toBe(
      `/api/instance/${WORKSPACE_ID}`,
    );
    expect(mockCrossServiceFetch.mock.calls[0][1]).toEqual({
      method: "DELETE",
      headers: { "x-user-id": USER.id },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
  });

  it("proxies the globe non-ok response with the original status", async () => {
    mockCrossServiceFetch.mockResolvedValue(
      jsonResponse({ error: "Instance not found" }, 404),
    );

    const res = await DELETE(buildRequest(), { params: PARAMS });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Instance not found" });
  });

  it("returns 502 when the globe is unreachable (network error)", async () => {
    mockCrossServiceFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await DELETE(buildRequest(), { params: PARAMS });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/reach/i);
  });

  it("returns 401 when unauthenticated, without calling the globe", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const res = await DELETE(buildRequest(), { params: PARAMS });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
  });
});

describe("GET /api/provisioning/workspace/[id]", () => {
  it("proxies the globe GET and returns its response", async () => {
    mockCrossServiceFetch.mockResolvedValue(
      jsonResponse({ id: WORKSPACE_ID, subdomain: "acme", name: "Acme" }),
    );

    const res = await GET(buildRequest({ method: "GET" }), {
      params: PARAMS,
    });

    expect(mockCrossServiceFetch).toHaveBeenCalledTimes(1);
    expect(mockCrossServiceFetch.mock.calls[0][0]).toBe(
      `/api/instance/${WORKSPACE_ID}`,
    );
    expect(mockCrossServiceFetch.mock.calls[0][1]).toEqual({
      searchParams: { userId: USER.id },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const res = await GET(buildRequest({ method: "GET" }), {
      params: PARAMS,
    });

    expect(res.status).toBe(401);
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/provisioning/workspace/[id]", () => {
  it("proxies the globe PATCH and returns its response", async () => {
    mockCrossServiceFetch.mockResolvedValue(
      jsonResponse({ id: WORKSPACE_ID, name: "Renamed" }),
    );

    const res = await PATCH(buildRequest({ method: "PATCH", body: { name: "Renamed" } }), {
      params: PARAMS,
    });

    expect(mockCrossServiceFetch).toHaveBeenCalledTimes(1);
    expect(mockCrossServiceFetch.mock.calls[0][0]).toBe(
      `/api/instance/${WORKSPACE_ID}`,
    );
    expect(mockCrossServiceFetch.mock.calls[0][1]).toEqual({
      method: "PATCH",
      body: { name: "Renamed" },
      headers: { "x-user-id": USER.id },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const res = await PATCH(
      buildRequest({ method: "PATCH", body: { name: "Renamed" } }),
      { params: PARAMS },
    );

    expect(res.status).toBe(401);
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request(
      `https://wwv.local:3001/api/provisioning/workspace/${WORKSPACE_ID}`,
      { method: "PATCH", body: "{not-json" },
    );

    const res = await PATCH(req, { params: PARAMS });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
  });
});
