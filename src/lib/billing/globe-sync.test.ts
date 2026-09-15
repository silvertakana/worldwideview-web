import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCrossServiceFetch } = vi.hoisted(() => ({ mockCrossServiceFetch: vi.fn() }));

vi.mock("@/lib/cross-service/fetch", () => ({ crossServiceFetch: mockCrossServiceFetch }));

import { GLOBE_TIERS, isGlobeTier } from "@/lib/billing/globe-tiers";
import { pushTierToGlobe, readGlobeTier } from "@/lib/billing/globe-sync";

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
