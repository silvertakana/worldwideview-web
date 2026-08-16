import { describe, it, expect } from "vitest";
import {
  resolveDisplayTier,
  shouldConsultHubAuthority,
  type GlobeTierSnapshot,
} from "./display-tier";

// ── Helpers ───────────────────────────────────────────────────────

const HUB_PRO = { plan: "pro", status: "active", trialEndsAt: null, isTrialing: false };
const HUB_TEAM = { plan: "team", status: "active", trialEndsAt: null, isTrialing: false };
const HUB_PRO_TRIAL = {
  plan: "pro",
  status: "trialing",
  trialEndsAt: "2026-09-01T00:00:00.000Z",
  isTrialing: true,
};

function globe(overrides: Partial<GlobeTierSnapshot> = {}): GlobeTierSnapshot {
  return {
    succeeded: true,
    plan: null,
    tier: null,
    status: "active",
    trialEndsAt: null,
    isTrialing: false,
    ...overrides,
  };
}

// ── shouldConsultHubAuthority ─────────────────────────────────────

describe("shouldConsultHubAuthority", () => {
  it("is false when the globe reports a paid tier", () => {
    expect(shouldConsultHubAuthority(globe({ tier: "pro" }))).toBe(false);
    expect(shouldConsultHubAuthority(globe({ tier: "enterprise" }))).toBe(false);
    expect(shouldConsultHubAuthority(globe({ plan: "team" }))).toBe(false);
  });

  it("is true when the globe reports free", () => {
    expect(shouldConsultHubAuthority(globe({ tier: "free" }))).toBe(true);
  });

  it("is true when the globe response has no tier (defaults to free/local)", () => {
    expect(shouldConsultHubAuthority(globe({}))).toBe(true);
  });

  it("is true when the globe fetch failed or 404'd", () => {
    expect(shouldConsultHubAuthority(globe({ succeeded: false }))).toBe(true);
  });
});

// ── resolveDisplayTier — hub authority overrides a stale globe "free" ──

describe("resolveDisplayTier — globe free is inconclusive, hub authority wins", () => {
  it("globe free + hub pro → pro (hub source)", () => {
    const decision = resolveDisplayTier(globe({ tier: "free" }), HUB_PRO);
    expect(decision).toEqual({ ...HUB_PRO, source: "hub" });
  });

  it("globe free + hub team → team (hub source)", () => {
    const decision = resolveDisplayTier(globe({ tier: "free" }), HUB_TEAM);
    expect(decision).toEqual({ ...HUB_TEAM, source: "hub" });
  });

  it("globe free + hub trialing → pro with the hub's trialing status", () => {
    const decision = resolveDisplayTier(globe({ tier: "free" }), HUB_PRO_TRIAL);
    expect(decision).toEqual({ ...HUB_PRO_TRIAL, source: "hub" });
  });

  it("globe fetch failed (404) + hub pro → pro (hub source, existing behavior preserved)", () => {
    const decision = resolveDisplayTier(globe({ succeeded: false }), HUB_PRO);
    expect(decision).toEqual({ ...HUB_PRO, source: "hub" });
  });
});

// ── resolveDisplayTier — globe paid wins (mirror authoritative for paid) ──

describe("resolveDisplayTier — globe paid tier is conclusive", () => {
  it("globe pro + hub pro → pro (globe source)", () => {
    const decision = resolveDisplayTier(globe({ tier: "pro" }), HUB_PRO);
    expect(decision).toEqual({ plan: "pro", status: "active", trialEndsAt: null, isTrialing: false, source: "globe" });
  });

  it("globe pro + hub null → pro (globe wins even with no hub data)", () => {
    const decision = resolveDisplayTier(globe({ tier: "pro" }), null);
    expect(decision.plan).toBe("pro");
    expect(decision.source).toBe("globe");
  });

  it("globe enterprise + hub free → enterprise (globe wins when it reports paid)", () => {
    const decision = resolveDisplayTier(globe({ tier: "enterprise", status: "active" }), null);
    expect(decision.plan).toBe("enterprise");
    expect(decision.source).toBe("globe");
  });

  it("globe team + hub pro → team (the mirror's newer plan wins)", () => {
    const decision = resolveDisplayTier(globe({ plan: "team" }), HUB_PRO);
    expect(decision.plan).toBe("team");
    expect(decision.source).toBe("globe");
  });

  it("keeps the globe status/trial/isTrialing when the globe paid tier wins", () => {
    const decision = resolveDisplayTier(
      globe({ tier: "pro", status: "trialing", trialEndsAt: "2026-09-01T00:00:00.000Z", isTrialing: true }),
      null,
    );
    expect(decision).toEqual({
      plan: "pro",
      status: "trialing",
      trialEndsAt: "2026-09-01T00:00:00.000Z",
      isTrialing: true,
      source: "globe",
    });
  });
});

// ── resolveDisplayTier — fails safe to Free ───────────────────────

describe("resolveDisplayTier — fails safe to free", () => {
  it("globe free + hub null → local (the page's Free-plan label)", () => {
    const decision = resolveDisplayTier(globe({ tier: "free" }), null);
    expect(decision.plan).toBe("local");
    expect(decision.source).toBe("local");
  });

  it("globe free + hub free-equivalent (null) → local — getHubTierFallback never returns a paid plan for a free user", () => {
    // The hub fallback contract only yields paid plans (it returns null when
    // Stripe has no live sub and the highest entitlement is free), so the
    // "hub free" case IS the null case — and it must not invent a tier.
    const decision = resolveDisplayTier(globe({ tier: "free" }), null);
    expect(decision.plan).toBe("local");
  });

  it("globe fetch failed + hub null → local", () => {
    const decision = resolveDisplayTier(globe({ succeeded: false }), null);
    expect(decision.plan).toBe("local");
    expect(decision.status).toBe("not_found");
  });

  it("globe free keeps the globe status when no authority claims a paid tier", () => {
    const decision = resolveDisplayTier(globe({ tier: "free", status: "active" }), null);
    expect(decision.status).toBe("active");
    expect(decision.source).toBe("local");
  });
});
