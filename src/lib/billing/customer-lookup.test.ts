import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockCreateAdminClient,
  mockGetUserById,
  mockListUsers,
  mockGetSubscriptionByEmail,
  mockGetActiveOverride,
  mockListOverridesForUser,
  mockGetUserEntitlements,
} = vi.hoisted(() => ({
  mockCreateAdminClient: vi.fn(),
  mockGetUserById: vi.fn(),
  mockListUsers: vi.fn(),
  mockGetSubscriptionByEmail: vi.fn(),
  mockGetActiveOverride: vi.fn(),
  mockListOverridesForUser: vi.fn(),
  mockGetUserEntitlements: vi.fn(),
}));

// `@/lib/supabase/admin` carries `import 'server-only'`, which throws outside a
// server bundle, so it is always mocked in this repo's tests.
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mockCreateAdminClient }));

vi.mock("@/lib/billing/subscription-store", () => ({
  getSubscriptionByEmail: mockGetSubscriptionByEmail,
  getActiveOverride: mockGetActiveOverride,
  listOverridesForUser: mockListOverridesForUser,
}));

vi.mock("@/lib/auth/entitlements", () => ({ getUserEntitlements: mockGetUserEntitlements }));

import { findCustomer } from "@/lib/billing/customer-lookup";

const USER_ID = "11111111-2222-3333-4444-555555555555";
const ADMIN_ID = "99999999-8888-7777-6666-555555555555";

function hubUser(id: string, email: string) {
  return { data: { user: { id, email, created_at: "2026-01-01T00:00:00.000Z" } }, error: null };
}

function pageOf(users: Array<{ id: string; email: string }>) {
  return { data: { users: users.map((u) => ({ ...u, created_at: "2026-01-01T00:00:00.000Z" })) }, error: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateAdminClient.mockReturnValue({ auth: { admin: { getUserById: mockGetUserById, listUsers: mockListUsers } } });
  mockGetUserById.mockImplementation(async (id: string) => hubUser(id, `${id}@example.com`));
  mockListUsers.mockResolvedValue(pageOf([]));
  mockGetSubscriptionByEmail.mockResolvedValue(null);
  mockGetActiveOverride.mockResolvedValue(null);
  mockListOverridesForUser.mockResolvedValue([]);
  mockGetUserEntitlements.mockResolvedValue([]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/* ──────────────────────── resolving the customer ──────────────────────── */

describe("findCustomer", () => {
  it("asks for a lookup when nothing was typed", async () => {
    expect(await findCustomer("   ")).toEqual({
      ok: false,
      error: "Enter a customer email address or hub user id.",
    });
  });

  it("resolves a pasted user id directly", async () => {
    const result = await findCustomer(USER_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.userId).toBe(USER_ID);
    expect(mockGetUserById).toHaveBeenCalledWith(USER_ID);
    expect(mockListUsers).not.toHaveBeenCalled();
  });

  it("says so plainly when a pasted user id does not exist", async () => {
    mockGetUserById.mockResolvedValue({ data: { user: null }, error: { message: "User not found" } });

    const result = await findCustomer(USER_ID);

    expect(result).toEqual({ ok: false, error: `Supabase Auth has no user with the id ${USER_ID}.` });
  });

  it("short-circuits the user walk for an email the durable record already knows", async () => {
    mockGetSubscriptionByEmail.mockResolvedValue({
      user_id: USER_ID,
      email: "pay@example.com",
      stripe_subscription_id: "sub_1",
      status: "active",
      source: "stripe",
    });

    const result = await findCustomer("pay@example.com");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.userId).toBe(USER_ID);
    expect(mockListUsers).not.toHaveBeenCalled();
  });

  it("walks the user list when no billing record knows the email", async () => {
    mockListUsers
      .mockResolvedValueOnce(pageOf([{ id: "someone-else", email: "other@example.com" }]))
      .mockResolvedValueOnce(pageOf([{ id: USER_ID, email: "pay@example.com" }]));

    const result = await findCustomer("pay@example.com");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.userId).toBe(USER_ID);
    expect(mockListUsers).toHaveBeenCalledTimes(2);
  });

  it("matches the email case-insensitively", async () => {
    mockListUsers.mockResolvedValueOnce(pageOf([{ id: USER_ID, email: "Pay@Example.com" }]));

    const result = await findCustomer("pay@example.com");

    expect(result.ok).toBe(true);
  });

  it("says 'no such account' only after the walk actually finished", async () => {
    mockListUsers.mockResolvedValueOnce(pageOf([{ id: "someone-else", email: "other@example.com" }]));

    const result = await findCustomer("ghost@example.com");

    expect(result).toEqual({
      ok: false,
      error: "Supabase Auth has no user with the email ghost@example.com. Check the spelling, or paste the user id instead.",
    });
  });

  it("admits when it gave up rather than claiming the account does not exist", async () => {
    const fullPage = Array.from({ length: 200 }, (_, index) => ({ id: `user-${index}`, email: `u${index}@example.com` }));
    mockListUsers.mockResolvedValue(pageOf(fullPage));

    const result = await findCustomer("ghost@example.com");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Searched the first 5000 hub accounts");
    expect(result.error).not.toContain("has no user");
  });
});

/* ─────────────────────── the assembled picture ─────────────────────── */

describe("the customer picture", () => {
  it("handles a customer with no billing record at all", async () => {
    mockListUsers.mockResolvedValueOnce(pageOf([{ id: USER_ID, email: "new@example.com" }]));

    const result = await findCustomer("new@example.com");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.subscription).toBeNull();
    expect(result.customer.override).toBeNull();
    expect(result.customer.entitlements).toEqual([]);
  });

  it("surfaces an operator-owned record as source=manual instead of rewriting it", async () => {
    const manual = {
      user_id: USER_ID,
      email: "comped@example.com",
      stripe_subscription_id: null,
      plan: "pro",
      status: "active",
      source: "manual",
    };
    mockGetSubscriptionByEmail.mockResolvedValue(manual);
    mockListUsers.mockResolvedValueOnce(pageOf([{ id: USER_ID, email: "comped@example.com" }]));

    const result = await findCustomer("comped@example.com");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.subscription?.source).toBe("manual");
    expect(result.customer.subscription?.stripe_subscription_id).toBeNull();
  });

  it("carries the whole override history so the audit trail has a who, when and why", async () => {
    const history = [
      {
        id: "ov-2",
        user_id: USER_ID,
        tier: "pro",
        reason: "paid on 12 Sep, webhook failed",
        created_by: ADMIN_ID,
        created_at: "2026-09-12T10:00:00.000Z",
        revoked_at: null,
        revoked_by: null,
      },
      {
        id: "ov-1",
        user_id: USER_ID,
        tier: "team",
        reason: "early access grant",
        created_by: ADMIN_ID,
        created_at: "2026-08-01T10:00:00.000Z",
        revoked_at: "2026-09-12T09:00:00.000Z",
        revoked_by: ADMIN_ID,
      },
    ];
    mockListOverridesForUser.mockResolvedValue(history);
    mockGetActiveOverride.mockResolvedValue(history[0]);
    mockGetUserById.mockImplementation(async (id: string) => hubUser(id, `${id}@example.com`));

    const result = await findCustomer(USER_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.override?.tier).toBe("pro");
    expect(result.customer.history).toHaveLength(2);
    expect(result.customer.actors[ADMIN_ID]).toBe(`${ADMIN_ID}@example.com`);
  });
});
