import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCrossServiceFetch } = vi.hoisted(() => ({ mockCrossServiceFetch: vi.fn() }));

vi.mock("@/lib/cross-service/fetch", () => ({ crossServiceFetch: mockCrossServiceFetch }));

import { GLOBE_TIERS, isGlobeTier } from "@/lib/billing/globe-tiers";
import { pushTierToGlobe, readGlobeTier, readGlobeUsage } from "@/lib/billing/globe-sync";

interface FetchOpts {
  method?: string;
  body?: Record<string, unknown>;
  searchParams?: Record<string, string>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lastCall(): { path: string; opts: FetchOpts } {
  const call = mockCrossServiceFetch.mock.calls.at(-1) as [string, FetchOpts] | undefined;
  if (!call) throw new Error("crossServiceFetch was never called");
  return { path: call[0], opts: call[1] };
}

beforeEach(() => {
  mockCrossServiceFetch.mockReset();
});

/* ───────────────────── the vocabulary itself ───────────────────── */

describe("the globe's tier vocabulary", () => {
  it("is exactly the set tier-sync accepts", () => {
    expect([...GLOBE_TIERS]).toEqual(["free", "pro", "team", "enterprise"]);
  });

  it("refuses the hub-only tiers the globe rejects", () => {
    expect(isGlobeTier("beta_tester")).toBe(false);
    expect(isGlobeTier("early_access")).toBe(false);
    expect(isGlobeTier("pro")).toBe(true);
  });
});

/* ─────────────────────── pushTierToGlobe ─────────────────────── */

describe("pushTierToGlobe", () => {
  it("posts the tier to tier-sync with only the fields the globe reads", async () => {
    mockCrossServiceFetch.mockResolvedValue(json({ success: true, organizationId: "org_1", tier: "pro" }));

    const result = await pushTierToGlobe({ email: "pay@example.com", tier: "pro" });

    expect(result.ok).toBe(true);
    const { path, opts } = lastCall();
    expect(path).toBe("/api/service/tier-sync");
    expect(opts.method).toBe("POST");
    expect(opts.body).toEqual({ email: "pay@example.com", tier: "pro", status: "active" });
    // The globe's route never reads periodEndsAt, so sending it would imply an
    // expiry the globe does not honour.
    expect(opts.body).not.toHaveProperty("periodEndsAt");
  });

  it("reports the globe's own words when it rejects the payload", async () => {
    mockCrossServiceFetch.mockResolvedValue(
      json({ error: "Invalid tier: beta_tester. Must be one of: free, pro, team, enterprise" }, 400),
    );

    const result = await pushTierToGlobe({ email: "pay@example.com", tier: "pro" });

    expect(result).toMatchObject({ ok: false, failure: "rejected" });
    if (result.ok) throw new Error("expected a failure");
    expect(result.detail).toContain("Invalid tier: beta_tester");
  });

  it("falls back to a readable message when the error body is not JSON", async () => {
    mockCrossServiceFetch.mockResolvedValue(new Response("<html>nope</html>", { status: 400 }));

    const result = await pushTierToGlobe({ email: "pay@example.com", tier: "pro" });

    expect(result).toMatchObject({ ok: false, failure: "rejected" });
    if (result.ok) throw new Error("expected a failure");
    expect(result.detail).toContain("400 Bad Request");
  });

  it("distinguishes 'no globe organization' from 'the globe refused us'", async () => {
    mockCrossServiceFetch.mockResolvedValue(json({ error: "Organization not found for email" }, 404));

    const result = await pushTierToGlobe({ email: "orphan@example.com", tier: "pro" });

    expect(result).toMatchObject({ ok: false, failure: "no-organization" });
    if (result.ok) throw new Error("expected a failure");
    expect(result.detail).toContain("no organization");
    expect(result.detail).toContain("orphan@example.com");
  });

  it("blames the shared secret, not the customer, on a 401", async () => {
    mockCrossServiceFetch.mockResolvedValue(json({ error: "Unauthorized" }, 401));

    const result = await pushTierToGlobe({ email: "pay@example.com", tier: "pro" });

    expect(result).toMatchObject({ ok: false, failure: "unreachable" });
    if (result.ok) throw new Error("expected a failure");
    expect(result.detail).toContain("CROSS_SERVICE_SECRET");
  });

  it("treats any other status as unreachable", async () => {
    mockCrossServiceFetch.mockResolvedValue(json({ error: "boom" }, 500));

    const result = await pushTierToGlobe({ email: "pay@example.com", tier: "pro" });

    expect(result).toMatchObject({ ok: false, failure: "unreachable" });
    if (result.ok) throw new Error("expected a failure");
    expect(result.detail).toContain("500");
  });

  it("never throws when the globe is unreachable", async () => {
    mockCrossServiceFetch.mockRejectedValue(new Error("PROVISIONING_API_URL is required"));

    const result = await pushTierToGlobe({ email: "pay@example.com", tier: "pro" });

    expect(result).toMatchObject({ ok: false, failure: "unreachable" });
    if (result.ok) throw new Error("expected a failure");
    expect(result.detail).toContain("PROVISIONING_API_URL is required");
  });
});

/* ──────────────────────── readGlobeTier ──────────────────────── */

describe("readGlobeTier", () => {
  it("asks for the tier by email and returns the globe's own numbers", async () => {
    mockCrossServiceFetch.mockResolvedValue(
      json({
        tier: "pro",
        status: "active",
        effectiveTier: "pro",
        effectiveStatus: "active",
        instanceCount: 2,
      }),
    );

    const result = await readGlobeTier("pay@example.com");

    expect(result).toEqual({
      ok: true,
      state: {
        tier: "pro",
        status: "active",
        effectiveTier: "pro",
        effectiveStatus: "active",
        instanceCount: 2,
      },
    });
    const { path, opts } = lastCall();
    expect(path).toBe("/api/service/tier");
    expect(opts.searchParams).toEqual({ email: "pay@example.com" });
  });

  it("reports a missing organization before anything is written", async () => {
    mockCrossServiceFetch.mockResolvedValue(json({ error: "Organization not found for email" }, 404));

    const result = await readGlobeTier("orphan@example.com");

    expect(result).toMatchObject({ ok: false, failure: "no-organization" });
  });

  it("reports an unreachable globe without throwing", async () => {
    mockCrossServiceFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const result = await readGlobeTier("pay@example.com");

    expect(result).toMatchObject({ ok: false, failure: "unreachable" });
    if (result.ok) throw new Error("expected a failure");
    expect(result.detail).toContain("connect ECONNREFUSED");
  });
});

/* ─────────────────────── readGlobeUsage ─────────────────────── */

/** The globe's own usage payload, as the signed route returns it. */
function usageBody() {
  return {
    period: { start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z", label: "2026-11" },
    keys: [
      {
        keyId: "key-1",
        userId: "user-1",
        name: "prod",
        prefix: "wwv_aaaaaaaa",
        calls: 984,
        tools: [
          { toolName: "investigate_area", calls: 900, lastCallAt: "2026-11-07T09:12:00.000Z" },
          { toolName: "search_entities", calls: 84, lastCallAt: "2026-11-07T09:10:00.000Z" },
        ],
      },
    ],
    totalCalls: 984,
    toolTotals: [
      { toolName: "investigate_area", calls: 900 },
      { toolName: "search_entities", calls: 84 },
    ],
  };
}

describe("readGlobeUsage", () => {
  it("gets the period from the signed route and returns the parsed usage", async () => {
    mockCrossServiceFetch.mockResolvedValue(json(usageBody()));

    const result = await readGlobeUsage({ period: "2026-11" });

    const { path, opts } = lastCall();
    expect(path).toBe("/api/service/usage");
    expect(opts.method).toBeUndefined(); // GET is the default, never a write
    expect(opts.searchParams).toEqual({ period: "2026-11" });
    if (!result.ok) throw new Error("expected usage");
    expect(result.usage.period.label).toBe("2026-11");
    expect(result.usage.totalCalls).toBe(984);
    expect(result.usage.keys[0]).toMatchObject({ keyId: "key-1", name: "prod", calls: 984 });
    expect(result.usage.keys[0].tools[0]).toEqual({
      toolName: "investigate_area",
      calls: 900,
      lastCallAt: "2026-11-07T09:12:00.000Z",
    });
  });

  it("passes the email through when one address is asked about", async () => {
    mockCrossServiceFetch.mockResolvedValue(json(usageBody()));

    await readGlobeUsage({ email: "pay@example.com", period: "2026-10" });

    expect(lastCall().opts.searchParams).toEqual({ email: "pay@example.com", period: "2026-10" });
  });

  it("maps 404 to no-organization, naming the address it asked about", async () => {
    mockCrossServiceFetch.mockResolvedValue(json({ error: "Account not found for email" }, 404));

    const result = await readGlobeUsage({ email: "nobody@example.com", period: "2026-11" });

    expect(result).toMatchObject({ ok: false, failure: "no-organization" });
    if (result.ok) throw new Error("expected a failure");
    expect(result.detail).toContain("nobody@example.com");
  });

  it("maps 401 to unreachable, because a wrong secret is our problem", async () => {
    mockCrossServiceFetch.mockResolvedValue(json({ error: "Unauthorized" }, 401));

    const result = await readGlobeUsage({ period: "2026-11" });

    expect(result).toMatchObject({ ok: false, failure: "unreachable" });
    if (result.ok) throw new Error("expected a failure");
    expect(result.detail).toContain("CROSS_SERVICE_SECRET");
  });

  it("treats a malformed body as unreachable, never as zero calls", async () => {
    // A body that parses but cannot be read as usage is the dangerous case: a
    // zero-call default would be invoiced.
    for (const body of [
      {},
      { keys: [], totalCalls: 0 },
      { period: { start: "x", end: "y", label: "z" }, keys: "nope", totalCalls: 0 },
      { period: { start: "x", end: "y", label: "z" }, keys: [], totalCalls: "many" },
    ]) {
      mockCrossServiceFetch.mockResolvedValue(json(body));
      const result = await readGlobeUsage({ period: "2026-11" });
      expect(result.ok, JSON.stringify(body)).toBe(false);
      if (result.ok) continue;
      expect(result.failure).toBe("unreachable");
    }
  });

  it("accepts a well-formed month in which nothing was called as zero calls", async () => {
    // The distinction the malformed-body test depends on: an EMPTY month is a
    // real answer, an UNREADABLE body is not. Conflating them would either
    // invent calls or hide a month of them.
    mockCrossServiceFetch.mockResolvedValue(
      json({ period: { start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z", label: "2026-11" }, keys: [], totalCalls: 0 }),
    );

    const result = await readGlobeUsage({ period: "2026-11" });

    if (!result.ok) throw new Error("expected a zero-call usage report");
    expect(result.usage.totalCalls).toBe(0);
    expect(result.usage.keys).toEqual([]);
  });

  it("drops a key row that does not carry a keyId and a count", async () => {
    mockCrossServiceFetch.mockResolvedValue(
      json({
        ...usageBody(),
        keys: [{ keyId: "key-1", calls: 5, name: null, prefix: null, userId: null, tools: [] }, { calls: 9 }],
      }),
    );

    const result = await readGlobeUsage({ period: "2026-11" });

    if (!result.ok) throw new Error("expected usage");
    expect(result.usage.keys).toHaveLength(1);
  });

  it("reports an unreachable globe as unreachable", async () => {
    mockCrossServiceFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await readGlobeUsage({ period: "2026-11" });

    expect(result).toMatchObject({ ok: false, failure: "unreachable" });
  });
});
