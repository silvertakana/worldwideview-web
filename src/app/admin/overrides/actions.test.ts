import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetUser,
  mockSetOverride,
  mockRevokeOverride,
  mockGetActiveOverride,
  mockListOverridesForUser,
  mockGetSubscriptionByEmail,
  mockGetUserEntitlements,
  mockRecordFailure,
  mockListUnresolvedFailures,
  mockResolveFailure,
  mockResolveEffectiveHubTier,
  mockCrossServiceFetch,
  mockRevalidatePath,
  mockCreateAdminClient,
  mockGetUserById,
  mockListUsers,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockSetOverride: vi.fn(),
  mockRevokeOverride: vi.fn(),
  mockGetActiveOverride: vi.fn(),
  mockListOverridesForUser: vi.fn(),
  mockGetSubscriptionByEmail: vi.fn(),
  mockGetUserEntitlements: vi.fn(),
  mockRecordFailure: vi.fn(),
  mockListUnresolvedFailures: vi.fn(),
  mockResolveFailure: vi.fn(),
  mockResolveEffectiveHubTier: vi.fn(),
  mockCrossServiceFetch: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockCreateAdminClient: vi.fn(),
  mockGetUserById: vi.fn(),
  mockListUsers: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mockCreateAdminClient }));
vi.mock("@/lib/billing/subscription-store", () => ({
  setOverride: mockSetOverride,
  revokeOverride: mockRevokeOverride,
  getActiveOverride: mockGetActiveOverride,
  listOverridesForUser: mockListOverridesForUser,
  getSubscriptionByEmail: mockGetSubscriptionByEmail,
}));
vi.mock("@/lib/billing/records", () => ({
  recordFailure: mockRecordFailure,
  resolveFailure: mockResolveFailure,
  listUnresolvedFailures: mockListUnresolvedFailures,
}));
vi.mock("@/lib/billing/tier-rank", () => ({ resolveEffectiveHubTier: mockResolveEffectiveHubTier }));
vi.mock("@/lib/auth/entitlements", () => ({ getUserEntitlements: mockGetUserEntitlements }));
vi.mock("@/lib/cross-service/fetch", () => ({ crossServiceFetch: mockCrossServiceFetch }));

// The REAL globe-sync, manual-override and customer-lookup run here: the tier
// vocabulary, the reason rule and the partial-success reporting are exactly what
// these tests exist to hold down. Only their boundaries are mocked.
import { grantOverride, lookupCustomer, retryGlobePush, revokeOverrideAction } from "./actions";

const EMAIL = "pay@example.com";
const USER_ID = "11111111-2222-3333-4444-555555555555";
const ADMIN_ID = "99999999-8888-7777-6666-555555555555";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function signIn(role: string | undefined) {
  mockGetUser.mockResolvedValue({
    data: { user: { id: ADMIN_ID, email: "admin@example.com", app_metadata: role ? { role } : {} } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  signIn("admin");

  mockSetOverride.mockResolvedValue({
    id: "ov-1",
    user_id: USER_ID,
    tier: "pro",
    reason: "paid, webhook failed",
    created_by: ADMIN_ID,
    created_at: "2026-09-15T00:00:00.000Z",
    revoked_at: null,
  });
  mockRevokeOverride.mockResolvedValue(true);
  mockResolveEffectiveHubTier.mockResolvedValue({
    tier: "pro",
    source: "stripe",
    tiers: { stripe: "pro", entitlement: null, override: null },
    errors: {},
  });
  mockRecordFailure.mockResolvedValue(true);
  mockListUnresolvedFailures.mockResolvedValue([]);
  mockResolveFailure.mockResolvedValue(true);
  mockCrossServiceFetch.mockResolvedValue(json({ success: true, organizationId: "org_1" }));

  mockGetUserById.mockImplementation(async (id: string) => ({
    data: {
      user: { id, email: id === USER_ID ? EMAIL : `${id}@example.com`, created_at: "2026-01-01T00:00:00.000Z" },
    },
    error: null,
  }));
  mockListUsers.mockResolvedValue({ data: { users: [] }, error: null });
  mockCreateAdminClient.mockReturnValue({
    auth: { admin: { getUserById: mockGetUserById, listUsers: mockListUsers } },
  });
  mockGetSubscriptionByEmail.mockResolvedValue(null);
  mockGetActiveOverride.mockResolvedValue(null);
  mockListOverridesForUser.mockResolvedValue([]);
  mockGetUserEntitlements.mockResolvedValue([]);

  vi.spyOn(console, "error").mockImplementation(() => {});
});

const grant = { userId: USER_ID, email: EMAIL, tier: "pro", reason: "paid on 12 Sep, webhook failed" };

/* ─────────────────────────── authorization ─────────────────────────── */

describe("authorization", () => {
  it("refuses every action for a signed-in non-admin", async () => {
    signIn("user");

    expect(await lookupCustomer(EMAIL)).toEqual({ ok: false, error: "Unauthorized" });
    expect(await grantOverride(grant)).toMatchObject({ ok: false, stage: "unauthorized" });
    expect(await revokeOverrideAction({ userId: USER_ID, email: EMAIL, overrideId: "ov-1" })).toMatchObject({
      ok: false,
      stage: "unauthorized",
    });
    expect(await retryGlobePush({ userId: USER_ID, email: EMAIL, tier: "pro" })).toMatchObject({
      ok: false,
      stage: "unauthorized",
    });

    expect(mockSetOverride).not.toHaveBeenCalled();
    expect(mockRevokeOverride).not.toHaveBeenCalled();
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    expect(await grantOverride(grant)).toMatchObject({ ok: false, stage: "unauthorized" });
    expect(mockSetOverride).not.toHaveBeenCalled();
  });
});

/* ─────────────────────── the mandatory reason ─────────────────────── */

describe("the mandatory reason", () => {
  it("refuses a blank reason and writes nothing", async () => {
    const result = await grantOverride({ ...grant, reason: "" });

    expect(result).toMatchObject({ ok: false, stage: "validation" });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toContain("A reason is required");
    expect(mockSetOverride).not.toHaveBeenCalled();
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
  });

  it("refuses a reason made only of whitespace", async () => {
    const result = await grantOverride({ ...grant, reason: "   \n  " });

    expect(result).toMatchObject({ ok: false, stage: "validation" });
    expect(mockSetOverride).not.toHaveBeenCalled();
  });

  it("stores the reason trimmed, and passes the admin's id as the author", async () => {
    await grantOverride({ ...grant, reason: "  paid, webhook failed  " });

    expect(mockSetOverride).toHaveBeenCalledWith(USER_ID, "pro", "paid, webhook failed", ADMIN_ID);
  });
});

/* ──────────────────── tiers the globe cannot take ──────────────────── */

describe("tier validation", () => {
  it("refuses a hub-only tier instead of silently mapping it", async () => {
    const result = await grantOverride({ ...grant, tier: "beta_tester" });

    expect(result).toMatchObject({ ok: false, stage: "validation" });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toContain("free, pro, team, enterprise");
    expect(mockSetOverride).not.toHaveBeenCalled();
  });

  it("accepts every tier the globe accepts", async () => {
    for (const tier of ["free", "pro", "team", "enterprise"]) {
      const result = await grantOverride({ ...grant, tier });
      expect(result.ok).toBe(true);
    }
  });
});

/* ───────────────────── hub and globe disagreeing ───────────────────── */

describe("when the hub write lands and the globe push does not", () => {
  it("reports a failure, not a success, and files a retryable failure row", async () => {
    mockCrossServiceFetch.mockResolvedValue(json({ error: "Organization not found for email" }, 404));

    const result = await grantOverride(grant);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.stage).toBe("globe");
    expect(result.overrideId).toBe("ov-1");
    expect(result.error).toContain("no organization");

    expect(mockRecordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "tier_sync", eventId: `manual-override:${USER_ID}`, email: EMAIL }),
    );
  });

  it("reports success only when both halves landed", async () => {
    const result = await grantOverride(grant);

    expect(result).toMatchObject({ ok: true, overrideId: "ov-1" });
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it("says the hub failed, and writes nothing to the globe, when the override cannot be recorded", async () => {
    mockSetOverride.mockRejectedValue(new Error("[billing] setOverride failed: duplicate key"));

    const result = await grantOverride(grant);

    expect(result).toMatchObject({ ok: false, stage: "hub" });
    if (result.ok) throw new Error("expected a failure");
    expect(result.error).toContain("duplicate key");
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
  });

  it("retries the exact tier that failed and closes the failure row on success", async () => {
    mockListUnresolvedFailures.mockResolvedValue([
      { id: "fail-1", stage: "tier_sync", event_id: `manual-override:${USER_ID}`, resolved_at: null },
    ]);

    const result = await retryGlobePush({ userId: USER_ID, email: EMAIL, tier: "pro" });

    expect(result).toMatchObject({ ok: true });
    expect(mockResolveFailure).toHaveBeenCalledWith("fail-1");
  });

  it("keeps the failure open when the retry fails too", async () => {
    mockCrossServiceFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const result = await retryGlobePush({ userId: USER_ID, email: EMAIL, tier: "pro" });

    expect(result).toMatchObject({ ok: false, stage: "globe" });
    expect(mockResolveFailure).not.toHaveBeenCalled();
    expect(mockRecordFailure).toHaveBeenCalled();
  });
});

/* ─────────────────────────────── revoking ─────────────────────────────── */

describe("revoking an override", () => {
  it("mirrors whatever tier the customer has left", async () => {
    mockResolveEffectiveHubTier.mockResolvedValue({
      tier: "team",
      source: "stripe",
      tiers: { stripe: "team", entitlement: null, override: null },
      errors: {},
    });

    const result = await revokeOverrideAction({ userId: USER_ID, email: EMAIL, overrideId: "ov-1" });

    expect(mockRevokeOverride).toHaveBeenCalledWith("ov-1", ADMIN_ID);
    expect(result).toMatchObject({ ok: true, tier: "team", globe: "synced" });
    const body = mockCrossServiceFetch.mock.calls[0][1].body as Record<string, unknown>;
    expect(body).toEqual({ email: EMAIL, tier: "team", status: "active" });
  });

  it("leaves the globe alone rather than downgrading a customer to a tier it cannot express", async () => {
    mockResolveEffectiveHubTier.mockResolvedValue({
      tier: "beta_tester",
      source: "entitlement",
      tiers: { stripe: null, entitlement: "beta_tester", override: null },
      errors: {},
    });

    const result = await revokeOverrideAction({ userId: USER_ID, email: EMAIL, overrideId: "ov-1" });

    expect(result).toMatchObject({ ok: true, tier: "beta_tester", globe: "skipped" });
    expect(mockCrossServiceFetch).not.toHaveBeenCalled();
  });

  it("still reports the revoke as done when the globe push afterwards fails", async () => {
    mockCrossServiceFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const result = await revokeOverrideAction({ userId: USER_ID, email: EMAIL, overrideId: "ov-1" });

    expect(result).toMatchObject({ ok: true, globe: "failed" });
    if (!result.ok) throw new Error("expected the revoke to be reported as done");
    expect(result.detail).toContain("the globe is still granting the old tier");
    expect(mockRecordFailure).toHaveBeenCalled();
  });
});

/* ──────────────────────────────── lookup ──────────────────────────────── */

describe("lookup", () => {
  it("returns the customer together with the globe's own view", async () => {
    mockGetSubscriptionByEmail.mockResolvedValue({
      user_id: USER_ID,
      email: EMAIL,
      stripe_subscription_id: "sub_1",
      plan: "pro",
      status: "active",
      source: "stripe",
    });
    mockCrossServiceFetch.mockResolvedValue(json({ tier: "pro", status: "active", instanceCount: 1 }));

    const result = await lookupCustomer(EMAIL);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.email).toBe(EMAIL);
    expect(result.globe).toMatchObject({ ok: true, state: { tier: "pro", instanceCount: 1 } });
  });

  it("still shows the customer when the globe cannot be reached", async () => {
    mockGetSubscriptionByEmail.mockResolvedValue({
      user_id: USER_ID,
      email: EMAIL,
      stripe_subscription_id: "sub_1",
      status: "active",
      source: "stripe",
    });
    mockCrossServiceFetch.mockRejectedValue(new Error("PROVISIONING_API_URL is required"));

    const result = await lookupCustomer(EMAIL);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.globe).toMatchObject({ ok: false, failure: "unreachable" });
  });

  it("passes a not-found customer straight back", async () => {
    const result = await lookupCustomer("ghost@example.com");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ghost@example.com");
  });

  it("revalidates the operator screen after a grant", async () => {
    await grantOverride(grant);

    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/overrides");
  });
});
