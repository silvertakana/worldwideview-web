import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockAdminClient } = vi.hoisted(() => ({ mockAdminClient: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mockAdminClient }));

import { upsertSubscriptionFromStripe, recordFailure, listUnresolvedFailures, resolveFailure } from "@/lib/billing/records";
import {
  getActiveOverride,
  getSubscriptionByEmail,
  listActiveSubscriptions,
  recordManualSubscription,
  setOverride,
  revokeOverride,
} from "@/lib/billing/subscription-store";

/* ───────────────────────── test double ─────────────────────────
 * createAdminClient() is mocked with a chainable query builder that records
 * every call. Reads terminate on maybeSingle() or on being awaited; writes
 * terminate on being awaited. The two terminals have separate response queues so
 * a read can never consume a queued write result. `respondFind` answers the
 * row-probing read, `respondWrite` the write.
 */

interface Call {
  table: string;
  op: string;
  args: unknown[];
}

const calls: Call[] = [];
const findQueue: unknown[] = [];
const writeQueue: unknown[] = [];

/** Queue the row-probe results IN ORDER: the first value answers the initial
 *  SELECT, a second one serves the re-read after a lost race. A queued `null`
 *  is read as data = null, so prefer `{ data: null, error: null }`. */
function respondFind(...results: unknown[]) {
  findQueue.push(...results);
}
function respondWrite(result: unknown) {
  writeQueue.push(result);
}
/** An exhausted queue is "no rows". */
function shift(queue: unknown[]) {
  return queue.length > 0 ? queue.shift() : { data: null, error: null };
}

/**
 * The mock distinguishes reads from writes by chain shape rather than by table:
 * a chain that called insert/update/upsert resolves from writeQueue, everything
 * else resolves from findQueue. Without that split, a read's own await would
 * trigger the builder's `then` and swallow the write result queued for the next
 * call.
 */
function makeBuilder(table: string) {
  const state = { write: false };
  const record = (op: string) => (...args: unknown[]) => {
    calls.push({ table, op, args });
    return builder;
  };
  const builder: Record<string, unknown> = {
    select: record("select"),
    eq: record("eq"),
    is: record("is"),
    neq: record("neq"),
    or: record("or"),
    limit: record("limit"),
    order: record("order"),
    single: record("single"),
    update: (...args: unknown[]) => {
      state.write = true;
      return record("update")(...args);
    },
    insert: (...args: unknown[]) => {
      state.write = true;
      return record("insert")(...args);
    },
    upsert: (...args: unknown[]) => {
      state.write = true;
      return record("upsert")(...args);
    },
    maybeSingle: () => {
      calls.push({ table, op: "maybeSingle", args: [] });
      return Promise.resolve(shift(findQueue));
    },
    // A read chain awaited directly (the list helpers) resolves from findQueue;
    // writers chain (insert() / update().eq()) before being awaited.
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(shift(state.write ? writeQueue : findQueue)).then(resolve, reject),
  };
  return builder as never;
}

function callsFor(op: string) {
  return calls.filter((c) => c.op === op);
}

beforeEach(() => {
  calls.length = 0;
  findQueue.length = 0;
  writeQueue.length = 0;
  mockAdminClient.mockReturnValue({ from: (table: string) => makeBuilder(table) });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ────────────── upsertSubscriptionFromStripe ────────────── */

describe("upsertSubscriptionFromStripe", () => {
  const base = {
    user_id: "user-1",
    email: "user@example.com",
    stripe_subscription_id: "sub_123",
    plan: "pro",
    status: "active",
  };

  it("creates a row when nothing is on file", async () => {
    const result = await upsertSubscriptionFromStripe(base);

    expect(result).toEqual({ ok: true, action: "created" });
    expect(callsFor("insert")).toHaveLength(1);
    expect(callsFor("update")).toHaveLength(0);
  });

  it("forces source to stripe and strips the Stripe timestamp from the payload", async () => {
    await upsertSubscriptionFromStripe({ ...base, eventCreated: 1757900000 });

    const payload = callsFor("insert")[0].args[0] as Record<string, unknown>;
    expect(payload.source).toBe("stripe");
    expect(payload.eventCreated).toBeUndefined();
    expect(typeof payload.updated_at).toBe("string");
  });

  it("never overwrites a manual row, and reports it instead of pretending success", async () => {
    respondFind({ data: { id: "row-manual", source: "manual", updated_at: "2026-09-01T00:00:00.000Z" }, error: null });

    const result = await upsertSubscriptionFromStripe(base);

    expect(result.ok).toBe(false);
    expect(result.action).toBe("manual-protected");
    expect(callsFor("insert")).toHaveLength(0);
    expect(callsFor("update")).toHaveLength(0);
  });

  it("ignores an event older than the stored row", async () => {
    respondFind({ data: { id: "row-1", source: "stripe", updated_at: "2026-09-15T12:00:00.000Z" }, error: null });

    const result = await upsertSubscriptionFromStripe({ ...base, eventCreated: 1757900000 });

    expect(result.action).toBe("ignored");
    expect(callsFor("update")).toHaveLength(0);
    expect(callsFor("insert")).toHaveLength(0);
  });

  it("accepts an event newer than the stored row", async () => {
    respondFind({ data: { id: "row-1", source: "stripe", updated_at: "2026-09-01T00:00:00.000Z" }, error: null });
    respondWrite({ data: null, error: null });

    const result = await upsertSubscriptionFromStripe({ ...base, eventCreated: 1800000000 });

    expect(result.action).toBe("updated");
    expect(callsFor("update")).toHaveLength(1);
    expect(callsFor("eq").some((c) => c.args[0] === "id" && c.args[1] === "row-1")).toBe(true);
  });

  it("updates an existing stripe row even when no event timestamp is given", async () => {
    respondFind({ data: { id: "row-1", source: "stripe", updated_at: "2026-09-15T12:00:00.000Z" }, error: null });
    respondWrite({ data: null, error: null });

    const result = await upsertSubscriptionFromStripe(base);

    expect(result.action).toBe("updated");
    expect(callsFor("insert")).toHaveLength(0);
  });

  it("reports a write error instead of throwing", async () => {
    respondWrite({ data: null, error: { message: "42501 permission denied for table" } });

    const result = await upsertSubscriptionFromStripe(base);

    expect(result).toEqual({ ok: false, action: "error", detail: "42501 permission denied for table" });
  });

  it("re-reads and updates when it loses the insert race (23505 on email)", async () => {
    // The winner is keyed by EMAIL only, so the re-read's subscription-id probe
    // still finds nothing and falls through to the email probe, which finds the
    // row another worker just committed.
    const miss = { data: null, error: null };
    const winner = { data: { id: "row-winner", source: "stripe", updated_at: "2026-09-15T00:00:00.000Z" }, error: null };
    respondFind(miss, miss, winner);
    respondWrite({
      data: null,
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "idx_billing_subscriptions_email_unique"',
      },
    });
    respondWrite({ data: null, error: null });

    const result = await upsertSubscriptionFromStripe(base);

    expect(result.ok).toBe(true);
    expect(result.action).toBe("updated");
    expect(result.detail).toContain("lost the insert race");
    expect(callsFor("insert")).toHaveLength(1);
    expect(callsFor("update")).toHaveLength(1);
    expect(callsFor("eq").some((c) => c.args[0] === "id" && c.args[1] === "row-winner")).toBe(true);
  });

  it("protects a manual row it loses the insert race to (23505 on email)", async () => {
    // Same lost race as above, except the worker that won it was
    // recordManualSubscription: the winning row is an operator grant, so the
    // re-read has to apply the guard the initial read would have applied.
    const miss = { data: null, error: null };
    const winner = { data: { id: "row-manual-winner", source: "manual", updated_at: "2026-09-15T00:00:00.000Z" }, error: null };
    respondFind(miss, miss, winner);
    respondWrite({
      data: null,
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "idx_billing_subscriptions_email_unique"',
      },
    });

    const result = await upsertSubscriptionFromStripe(base);

    expect(result).toEqual({ ok: false, action: "manual-protected", detail: "row row-manual-winner is source=manual" });
    expect(callsFor("insert")).toHaveLength(1);
    expect(callsFor("update")).toHaveLength(0);
  });

  it("recognises the duplicate from the SQLSTATE alone, without a matching message", async () => {
    const miss = { data: null, error: null };
    const winner = { data: { id: "row-winner-2", source: "stripe", updated_at: "2026-09-15T00:00:00.000Z" }, error: null };
    respondFind(miss, miss, winner);
    respondWrite({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } });
    respondWrite({ data: null, error: null });

    const result = await upsertSubscriptionFromStripe(base);

    expect(result.action).toBe("updated");
    expect(callsFor("eq").some((c) => c.args[0] === "id" && c.args[1] === "row-winner-2")).toBe(true);
  });

  it("reports an error when the race is lost but the winning row cannot be found", async () => {
    const miss = { data: null, error: null };
    respondFind(miss, miss, miss);
    respondWrite({ data: null, error: { code: "23505", message: "duplicate key value" } });

    const result = await upsertSubscriptionFromStripe(base);

    expect(result.ok).toBe(false);
    expect(result.action).toBe("error");
    expect(result.detail).toContain("no row for");
    expect(callsFor("update")).toHaveLength(0);
  });

  it("does not mistake an unrelated write error for a lost race", async () => {
    respondFind({ data: null, error: null });
    respondWrite({ data: null, error: { code: "42501", message: "permission denied for table billing_subscriptions" } });

    const result = await upsertSubscriptionFromStripe(base);

    expect(result).toEqual({ ok: false, action: "error", detail: "permission denied for table billing_subscriptions" });
    expect(callsFor("update")).toHaveLength(0);
  });

  it("reports a thrown client failure instead of throwing", async () => {
    mockAdminClient.mockImplementation(() => {
      throw new Error("missing SUPABASE_SERVICE_ROLE_KEY");
    });

    const result = await upsertSubscriptionFromStripe(base);

    expect(result.ok).toBe(false);
    expect(result.action).toBe("error");
    expect(result.detail).toBe("missing SUPABASE_SERVICE_ROLE_KEY");
  });
});

/* ─────────────────────── overrides ─────────────────────── */

describe("overrides", () => {
  it("returns the active override for a user", async () => {
    respondFind({ data: { id: "ovr-1", user_id: "user-1", tier: "pro", reason: "support", revoked_at: null }, error: null });

    const override = await getActiveOverride("user-1");

    expect(override?.tier).toBe("pro");
    expect(callsFor("is").some((c) => c.args[0] === "revoked_at" && c.args[1] === null)).toBe(true);
  });

  it("returns null when the user has no active override", async () => {
    expect(await getActiveOverride("user-1")).toBeNull();
  });

  it("propagates a read error instead of reporting 'no override'", async () => {
    respondFind({ data: null, error: { message: "connection reset" } });

    await expect(getActiveOverride("user-1")).rejects.toThrow("connection reset");
  });

  it("revokes the current override before granting a new one", async () => {
    respondFind({ data: { id: "ovr-old", user_id: "user-1", tier: "pro", reason: "old", revoked_at: null }, error: null });
    respondWrite({ data: null, error: null });
    respondFind({ data: { id: "ovr-new", user_id: "user-1", tier: "team", reason: "upgraded", revoked_at: null }, error: null });

    const created = await setOverride("user-1", "team", "upgraded", "admin-1");

    expect(created?.id).toBe("ovr-new");
    const operations = calls.map((c) => c.op);
    expect(operations.indexOf("update")).toBeLessThan(operations.indexOf("insert"));
    const revokePayload = callsFor("update")[0].args[0] as Record<string, unknown>;
    expect(typeof revokePayload.revoked_at).toBe("string");
    expect(revokePayload.revoked_by).toBe("admin-1");
    const insertPayload = callsFor("insert")[0].args[0] as Record<string, unknown>;
    expect(insertPayload.tier).toBe("team");
    expect(insertPayload.reason).toBe("upgraded");
    expect(insertPayload.created_by).toBe("admin-1");
  });

  it("grants without a revoke when the user has no active override", async () => {
    respondFind({ data: null, error: null });
    respondFind({ data: { id: "ovr-new", user_id: "user-1", tier: "pro", reason: "first", revoked_at: null }, error: null });

    await setOverride("user-1", "pro", "first", null);

    expect(callsFor("update")).toHaveLength(0);
    expect(callsFor("insert")).toHaveLength(1);
  });

  it("revokes an override by id", async () => {
    respondWrite({ data: null, error: null });

    expect(await revokeOverride("ovr-1", "admin-1")).toBe(true);
    expect(callsFor("eq").some((c) => c.args[0] === "id" && c.args[1] === "ovr-1")).toBe(true);
  });
});

/* ─────────────────────── failure record ─────────────────────── */

/* ─────────────── manual records and active list ─────────────── */

describe("recordManualSubscription", () => {
  const input = { user_id: "user-1", email: "user@example.com", stripe_subscription_id: null, plan: "team", status: "active" };

  it("writes a manual row when the email has no record", async () => {
    respondFind({ data: null, error: null });
    respondWrite({ data: null, error: null });

    expect(await recordManualSubscription(input)).toEqual({ ok: true, action: "created" });

    const payload = callsFor("insert")[0].args[0] as Record<string, unknown>;
    expect(payload.source).toBe("manual");
  });

  it("updates an existing manual row instead of inserting a second one", async () => {
    respondFind({ data: { id: "row-manual", source: "manual", email: "user@example.com" }, error: null });
    respondWrite({ data: null, error: null });

    expect(await recordManualSubscription(input)).toEqual({ ok: true, action: "updated" });
    expect(callsFor("insert")).toHaveLength(0);
  });

  it("refuses to overwrite a row that Stripe owns", async () => {
    respondFind({ data: { id: "row-stripe", source: "stripe", email: "user@example.com" }, error: null });

    const result = await recordManualSubscription(input);

    expect(result.ok).toBe(false);
    expect(result.action).toBe("ignored");
    expect(callsFor("insert")).toHaveLength(0);
    expect(callsFor("update")).toHaveLength(0);
  });
});

describe("reads", () => {
  it("lists only live subscriptions for the reconciler", async () => {
    respondFind({ data: [{ id: "row-1", email: "a@b.com", status: "active" }], error: null });

    const active = await listActiveSubscriptions();

    expect(active).toHaveLength(1);
    expect(callsFor("neq")[0].args).toEqual(["status", "canceled"]);
  });

  it("reads one record per email for the override flow", async () => {
    respondFind({ data: { id: "row-1", email: "a@b.com", source: "manual" }, error: null });

    const record = await getSubscriptionByEmail("a@b.com");

    expect(record?.source).toBe("manual");
    expect(callsFor("eq").some((c) => c.args[0] === "email" && c.args[1] === "a@b.com")).toBe(true);
  });

  it("propagates a read failure instead of returning an empty list", async () => {
    respondFind({ data: null, error: { message: "connection reset" } });

    await expect(listActiveSubscriptions()).rejects.toThrow("connection reset");
  });
});

describe("recordFailure", () => {
  it("inserts a new unresolved failure with one attempt", async () => {
    respondFind({ data: null, error: null });
    respondWrite({ data: null, error: null });

    expect(await recordFailure({ eventId: "evt_1", stage: "provision", email: "a@b.com" })).toBe(true);

    expect(callsFor("insert")).toHaveLength(1);
    const payload = callsFor("insert")[0].args[0] as Record<string, unknown>;
    expect(payload.stage).toBe("provision");
    expect(payload.attempts).toBe(1);
    expect(payload.event_id).toBe("evt_1");
    expect(payload.email).toBe("a@b.com");
    expect(payload.resolved_at).toBeUndefined();
  });

  it("increments attempts on the same unresolved event and stage", async () => {
    respondFind({ data: { id: "fail-1", attempts: 2 }, error: null });
    respondWrite({ data: null, error: null });

    expect(await recordFailure({ eventId: "evt_1", stage: "provision", error: "boom" })).toBe(true);

    expect(callsFor("update")).toHaveLength(1);
    const payload = callsFor("update")[0].args[0] as Record<string, unknown>;
    expect(payload.attempts).toBe(3);
    expect(payload.error).toBe("boom");
    expect(typeof payload.last_attempt_at).toBe("string");
    expect(callsFor("insert")).toHaveLength(0);
  });

  it("scopes the attempt count to the stage", async () => {
    respondFind({ data: null, error: null });
    respondWrite({ data: null, error: null });

    await recordFailure({ eventId: "evt_1", stage: "tier_sync" });

    const filters = callsFor("eq").map((c) => `${String(c.args[0])}=${String(c.args[1])}`);
    expect(filters).toContain("stage=tier_sync");
  });

  it("falls back to the event type when there is no event id", async () => {
    respondFind({ data: null, error: null });
    respondWrite({ data: null, error: null });

    await recordFailure({ eventType: "checkout.session.completed", stage: "provision" });

    const payload = callsFor("insert")[0].args[0] as Record<string, unknown>;
    expect(payload.event_type).toBe("checkout.session.completed");
    expect(payload.event_id).toBeNull();
  });

  it("returns false, not success, when the write fails", async () => {
    respondFind({ data: null, error: null });
    respondWrite({ data: null, error: { message: "42501 permission denied" } });

    expect(await recordFailure({ eventId: "evt_1", stage: "provision" })).toBe(false);
  });

  it("returns false instead of throwing when the client is unavailable", async () => {
    mockAdminClient.mockImplementation(() => {
      throw new Error("no service role key");
    });

    expect(await recordFailure({ eventId: "evt_1", stage: "provision" })).toBe(false);
  });

  it("lists unresolved failures oldest first", async () => {
    respondFind({ data: [{ id: "fail-1", stage: "provision", attempts: 1, resolved_at: null }], error: null });

    const failures = await listUnresolvedFailures();

    expect(failures).toHaveLength(1);
    expect(callsFor("order")[0].args).toEqual(["first_seen_at", { ascending: true }]);
    expect(callsFor("is").some((c) => c.args[0] === "resolved_at")).toBe(true);
  });

  it("resolves a failure by id", async () => {
    respondWrite({ data: null, error: null });

    expect(await resolveFailure("fail-1")).toBe(true);
    const payload = callsFor("update")[0].args[0] as Record<string, unknown>;
    expect(typeof payload.resolved_at).toBe("string");
    expect(callsFor("eq").some((c) => c.args[0] === "id" && c.args[1] === "fail-1")).toBe(true);
  });
});
