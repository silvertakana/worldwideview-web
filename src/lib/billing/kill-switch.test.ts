import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockAdminClient } = vi.hoisted(() => ({ mockAdminClient: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mockAdminClient }));

import {
  isBillingPaused,
  invalidateBillingKillSwitchCache,
  KILL_SWITCH_CACHE_TTL_MS,
} from "@/lib/billing/kill-switch";

/* ───────────────────────── test double ─────────────────────────
 * createAdminClient() is mocked with the chainable query builder from
 * records.test.ts, trimmed to the single chain this module uses
 * (from().select().limit().maybeSingle()). Every call is recorded so a test can
 * prove how many times the database was actually touched - which is the whole
 * point of the cache. `respondRead` queues answers IN ORDER; an exhausted queue
 * is read as "no row", which the module reports as unavailable.
 */

interface Call {
  table: string;
  op: string;
  args: unknown[];
}

const calls: Call[] = [];
const readQueue: unknown[] = [];

/** Queue the database answers IN ORDER. A queued `null` is read as data = null,
 *  so prefer `{ data: null, error: null }` when a test means "no row". */
function respondRead(...results: unknown[]) {
  readQueue.push(...results);
}

function shift(queue: unknown[]) {
  return queue.length > 0 ? queue.shift() : { data: null, error: null };
}

function makeBuilder(table: string) {
  const record = (op: string) => (...args: unknown[]) => {
    calls.push({ table, op, args });
    return builder;
  };
  const builder: Record<string, unknown> = {
    select: record("select"),
    limit: record("limit"),
    eq: record("eq"),
    maybeSingle: () => {
      calls.push({ table, op: "maybeSingle", args: [] });
      return Promise.resolve(shift(readQueue));
    },
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(shift(readQueue)).then(resolve, reject),
  };
  return builder as never;
}

function callsFor(op: string) {
  return calls.filter((c) => c.op === op);
}

/** How many times the module actually read the table. */
function queriesRun() {
  return callsFor("maybeSingle").length;
}

const ORIGINAL_KILL_SWITCH = process.env.BILLING_KILL_SWITCH;

const ENV_REASON = "Billing is paused by the BILLING_KILL_SWITCH environment variable.";
const NOT_PAUSED_ROW = { data: { billing_paused: false, reason: null }, error: null };
const MISSING_TABLE = {
  data: null,
  error: { message: 'relation "public.billing_control" does not exist', code: "42P01" },
};

beforeEach(() => {
  delete process.env.BILLING_KILL_SWITCH;
  invalidateBillingKillSwitchCache();
  calls.length = 0;
  readQueue.length = 0;
  mockAdminClient.mockReset();
  mockAdminClient.mockImplementation(() => ({ from: (table: string) => makeBuilder(table) }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (ORIGINAL_KILL_SWITCH === undefined) {
    delete process.env.BILLING_KILL_SWITCH;
  } else {
    process.env.BILLING_KILL_SWITCH = ORIGINAL_KILL_SWITCH;
  }
});

/* ────────────────── the env backstop ────────────────── */

describe("the BILLING_KILL_SWITCH env backstop", () => {
  for (const raw of ["true", "1", "YES", " true "]) {
    it(`pauses on ${JSON.stringify(raw)} and never touches the database`, async () => {
      respondRead(NOT_PAUSED_ROW);
      process.env.BILLING_KILL_SWITCH = raw;

      const state = await isBillingPaused();

      expect(state).toEqual({ paused: true, source: "env", reason: ENV_REASON });
      expect(mockAdminClient).not.toHaveBeenCalled();
      expect(queriesRun()).toBe(0);
    });
  }

  it("leaves any other value to the database row", async () => {
    respondRead(NOT_PAUSED_ROW);
    process.env.BILLING_KILL_SWITCH = "false";

    expect(await isBillingPaused()).toEqual({ paused: false, source: "database" });
    expect(queriesRun()).toBe(1);
  });

  it("is read on every call, so it stays an instant backstop with no invalidation", async () => {
    respondRead(NOT_PAUSED_ROW);
    expect(await isBillingPaused()).toEqual({ paused: false, source: "database" });

    // No invalidateBillingKillSwitchCache(): the cached database answer is still
    // well inside its TTL and must not win over the env check.
    process.env.BILLING_KILL_SWITCH = "TRUE";

    expect(await isBillingPaused()).toEqual({ paused: true, source: "env", reason: ENV_REASON });
    expect(mockAdminClient).toHaveBeenCalledTimes(1);
  });
});

/* ────────────────── the database row ────────────────── */

describe("the billing_control row", () => {
  it("reports a pause with the operator's reason", async () => {
    respondRead({ data: { billing_paused: true, reason: "incident-42" }, error: null });

    const state = await isBillingPaused();

    expect(state).toEqual({ paused: true, source: "database", reason: "incident-42" });
    expect(callsFor("select")[0].args[0]).toBe("billing_paused, reason");
    expect(callsFor("limit")[0].args[0]).toBe(1);
  });

  it("omits reason entirely when the column is null", async () => {
    respondRead({ data: { billing_paused: true, reason: null }, error: null });

    const state = await isBillingPaused();

    expect(state.paused).toBe(true);
    expect(state.source).toBe("database");
    expect("reason" in state).toBe(false);
  });

  it("reports not paused when the row says false", async () => {
    respondRead(NOT_PAUSED_ROW);

    expect(await isBillingPaused()).toEqual({ paused: false, source: "database" });
  });
});

/* ────────────── failing closed on an unknown state ────────────── */

describe("failing closed when the state is unknown", () => {
  it("treats a thrown client (unreachable database) as unavailable", async () => {
    mockAdminClient.mockImplementation(() => {
      throw new Error("ENOTFOUND");
    });

    const state = await isBillingPaused();

    expect(state).toEqual({ paused: true, source: "unavailable" });
    expect("reason" in state).toBe(false);
    expect(console.error).toHaveBeenCalledWith("[billing] kill-switch database read failed: ENOTFOUND");
  });

  it("treats a Supabase error object (missing table) as unavailable", async () => {
    respondRead(MISSING_TABLE);

    const state = await isBillingPaused();

    expect(state).toEqual({ paused: true, source: "unavailable" });
    expect("reason" in state).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      '[billing] kill-switch database read failed: relation "public.billing_control" does not exist',
    );
  });

  it("treats a missing row as an unknown state, not as 'not paused'", async () => {
    respondRead({ data: null, error: null });

    const state = await isBillingPaused();

    expect(state).toEqual({ paused: true, source: "unavailable" });
    expect("reason" in state).toBe(false);
  });

  it("never rejects when the client throws", async () => {
    mockAdminClient.mockImplementation(() => {
      throw new Error("ENOTFOUND");
    });

    await expect(isBillingPaused()).resolves.toMatchObject({ paused: true, source: "unavailable" });
  });

  it("never rejects when Supabase returns an error object", async () => {
    respondRead(MISSING_TABLE);

    await expect(isBillingPaused()).resolves.toMatchObject({ paused: true, source: "unavailable" });
  });
});

/* ────────────────── the in-process cache ────────────────── */

describe("the in-process cache", () => {
  it("serves a second call from cache and re-queries only after an invalidation", async () => {
    respondRead(NOT_PAUSED_ROW);

    expect(await isBillingPaused()).toEqual({ paused: false, source: "database" });
    expect(await isBillingPaused()).toEqual({ paused: false, source: "database" });
    expect(queriesRun()).toBe(1);

    invalidateBillingKillSwitchCache();
    respondRead(NOT_PAUSED_ROW);

    expect(await isBillingPaused()).toEqual({ paused: false, source: "database" });
    expect(queriesRun()).toBe(2);
  });

  it("does not re-query while the cached answer is still fresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T17:00:00.000Z"));
    respondRead(NOT_PAUSED_ROW);

    await isBillingPaused();
    vi.setSystemTime(Date.now() + KILL_SWITCH_CACHE_TTL_MS - 1);

    expect(await isBillingPaused()).toEqual({ paused: false, source: "database" });
    expect(queriesRun()).toBe(1);
  });

  it("re-queries once the TTL has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T17:00:00.000Z"));
    respondRead(NOT_PAUSED_ROW);

    expect(await isBillingPaused()).toEqual({ paused: false, source: "database" });
    expect(queriesRun()).toBe(1);

    vi.setSystemTime(Date.now() + KILL_SWITCH_CACHE_TTL_MS + 1);
    respondRead({ data: { billing_paused: true, reason: "incident-42" }, error: null });

    expect(await isBillingPaused()).toEqual({ paused: true, source: "database", reason: "incident-42" });
    expect(queriesRun()).toBe(2);
  });
});
