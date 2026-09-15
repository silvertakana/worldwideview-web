import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockFrom, mockCreateAdminClient } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockCreateAdminClient: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mockCreateAdminClient,
}));

import {
  claimWebhookEvent,
  completeWebhookEvent,
  failWebhookEvent,
} from "./webhook-idempotency";

// ── Supabase query-builder double ─────────────────────────────────
// Mirrors the terminal shapes the ledger uses:
//   .upsert(...).select("id").maybeSingle()
//   .select("processed_at").eq(...).maybeSingle()
//   .update(...).eq(...).is(...).select("id")      <- awaited directly
//   .insert(...)                                    <- awaited directly
// The builder is thenable too, so an awaited filter chain resolves to the row.

interface LedgerResult {
  data?: unknown;
  error?: { message: string } | null;
}

interface LedgerQuery {
  upsert: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  then: (onFulfilled: (value: LedgerResult) => unknown) => Promise<unknown>;
}

function ledgerQuery(result: LedgerResult): LedgerQuery {
  const query = {} as LedgerQuery;
  query.upsert = vi.fn(() => query);
  query.insert = vi.fn(() => query);
  query.update = vi.fn(() => query);
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.is = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => result);
  query.then = (onFulfilled: (value: LedgerResult) => unknown) =>
    Promise.resolve(result).then(onFulfilled);
  return query;
}

beforeEach(() => {
  mockFrom.mockReset();
  mockCreateAdminClient.mockReset();
  mockCreateAdminClient.mockReturnValue({ from: mockFrom });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────

describe("claimWebhookEvent", () => {
  it("claims a fresh event with processed_at NULL (unfinished, reprocessable)", async () => {
    const query = ledgerQuery({ data: { id: "row_1" }, error: null });
    mockFrom.mockReturnValueOnce(query);

    expect(await claimWebhookEvent("evt_1")).toBe("claimed");

    expect(query.upsert).toHaveBeenCalledWith(
      {
        event_id: "evt_1",
        processed_at: null,
        last_attempt_at: expect.any(String),
      },
      { onConflict: "event_id", ignoreDuplicates: true },
    );
  });

  it("stamps last_attempt_at at claim time so an abandoned claim is sweepable", async () => {
    // A process killed between claim and completion never reaches
    // failWebhookEvent. Without this stamp the row keeps last_attempt_at NULL,
    // which sorts last in webhook_events_unfinished_idx - so the freshest
    // abandoned work is the one thing nothing sweeps.
    const query = ledgerQuery({ data: { id: "row_1" }, error: null });
    mockFrom.mockReturnValueOnce(query);

    await claimWebhookEvent("evt_1");

    const payload = query.upsert.mock.calls[0][0] as Record<string, unknown>;
    expect(typeof payload.last_attempt_at).toBe("string");
    expect(Number.isNaN(Date.parse(payload.last_attempt_at as string))).toBe(false);
  });

  it("allows reprocessing when the existing row is claimed-but-unfinished (D1)", async () => {
    mockFrom
      .mockReturnValueOnce(ledgerQuery({ data: null, error: null }))
      .mockReturnValueOnce(ledgerQuery({ data: { processed_at: null }, error: null }));

    // A NULL processed_at means the earlier attempt threw after claiming, so a
    // redelivery must finish the work rather than short-circuit.
    expect(await claimWebhookEvent("evt_1")).toBe("claimed");
  });

  it("short-circuits when the existing row is completed", async () => {
    mockFrom
      .mockReturnValueOnce(ledgerQuery({ data: null, error: null }))
      .mockReturnValueOnce(
        ledgerQuery({ data: { processed_at: "2026-09-15T00:00:00.000Z" }, error: null }),
      );

    expect(await claimWebhookEvent("evt_1")).toBe("completed");
  });

  it("claims when no row is found at all (removed between the insert and the read)", async () => {
    mockFrom
      .mockReturnValueOnce(ledgerQuery({ data: null, error: null }))
      .mockReturnValueOnce(ledgerQuery({ data: null, error: null }));

    expect(await claimWebhookEvent("evt_1")).toBe("claimed");
  });

  it("fails open with 'unknown' when the claim insert errors", async () => {
    mockFrom.mockReturnValueOnce(ledgerQuery({ data: null, error: { message: "boom" } }));

    expect(await claimWebhookEvent("evt_1")).toBe("unknown");
  });

  it("fails open with 'unknown' when the state read errors", async () => {
    mockFrom
      .mockReturnValueOnce(ledgerQuery({ data: null, error: null }))
      .mockReturnValueOnce(ledgerQuery({ data: null, error: { message: "boom" } }));

    expect(await claimWebhookEvent("evt_1")).toBe("unknown");
  });

  it("fails open with 'unknown' when the admin client cannot be created", async () => {
    mockCreateAdminClient.mockImplementationOnce(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
    });

    expect(await claimWebhookEvent("evt_1")).toBe("unknown");
  });
});

describe("completeWebhookEvent", () => {
  it("completes an unfinished row, guarded on processed_at IS NULL", async () => {
    const query = ledgerQuery({ data: [{ id: "row_1" }], error: null });
    mockFrom.mockReturnValueOnce(query);

    await completeWebhookEvent("evt_1");

    const payload = query.update.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.last_error).toBeNull();
    expect(typeof payload.processed_at).toBe("string");
    expect(Number.isNaN(Date.parse(payload.processed_at as string))).toBe(false);
    expect(query.eq).toHaveBeenCalledWith("event_id", "evt_1");
    expect(query.is).toHaveBeenCalledWith("processed_at", null);
    // A blind onConflict upsert would rewrite processed_at on every replay.
    expect(query.upsert).not.toHaveBeenCalled();
    expect(query.insert).not.toHaveBeenCalled();
  });

  it("never moves the timestamp of an already-completed row", async () => {
    const unmatched = ledgerQuery({ data: [], error: null });
    const existing = ledgerQuery({ data: { id: "row_done" }, error: null });
    mockFrom.mockReturnValueOnce(unmatched).mockReturnValueOnce(existing);

    await completeWebhookEvent("evt_1");

    // The guarded update matched nothing and the row exists: the completion
    // timestamp is immutable, so this write is a no-op.
    expect(unmatched.update).toHaveBeenCalled();
    expect(existing.insert).not.toHaveBeenCalled();
  });

  it("inserts the row when the claim failed open and no row exists yet", async () => {
    const unmatched = ledgerQuery({ data: [], error: null });
    const missing = ledgerQuery({ data: null, error: null });
    const inserted = ledgerQuery({ data: null, error: null });
    mockFrom.mockReturnValueOnce(unmatched).mockReturnValueOnce(missing).mockReturnValueOnce(inserted);

    await completeWebhookEvent("evt_1");

    const payload = inserted.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.event_id).toBe("evt_1");
    expect(typeof payload.processed_at).toBe("string");
  });

  it("never throws when the completion write fails", async () => {
    // The guarded UPDATE itself errors, so it returns before the read.
    mockFrom.mockReturnValueOnce(ledgerQuery({ data: null, error: { message: "boom" } }));

    await expect(completeWebhookEvent("evt_1")).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("never throws when the row read after an unmatched update fails", async () => {
    mockFrom
      .mockReturnValueOnce(ledgerQuery({ data: [], error: null }))
      .mockReturnValueOnce(ledgerQuery({ data: null, error: { message: "boom" } }));

    await expect(completeWebhookEvent("evt_1")).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("never throws when the admin client cannot be created", async () => {
    mockCreateAdminClient.mockImplementationOnce(() => {
      throw new Error("down");
    });

    await expect(completeWebhookEvent("evt_1")).resolves.toBeUndefined();
  });
});

describe("failWebhookEvent", () => {
  it("records the error without completing the event, guarded on processed_at IS NULL", async () => {
    const query = ledgerQuery({ data: { id: "row_1" }, error: null });
    mockFrom.mockReturnValueOnce(query);

    await failWebhookEvent("evt_1", "stripe is down");

    const payload = query.update.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.last_error).toBe("stripe is down");
    expect(typeof payload.last_attempt_at).toBe("string");
    // processed_at is never written here: the row must stay unfinished.
    expect(payload.processed_at).toBeUndefined();
    expect(query.eq).toHaveBeenCalledWith("event_id", "evt_1");
    expect(query.is).toHaveBeenCalledWith("processed_at", null);
    // An upsert could resurrect/un-complete a concurrently completed row.
    expect(query.upsert).not.toHaveBeenCalled();
  });

  it("truncates an oversized error message", async () => {
    const query = ledgerQuery({ data: { id: "row_1" }, error: null });
    mockFrom.mockReturnValueOnce(query);

    await failWebhookEvent("evt_1", "x".repeat(1000));

    const payload = query.update.mock.calls[0][0] as Record<string, unknown>;
    expect((payload.last_error as string).length).toBe(500);
  });

  it("never throws when the failure write fails", async () => {
    mockFrom.mockReturnValueOnce(ledgerQuery({ data: null, error: { message: "boom" } }));

    await expect(failWebhookEvent("evt_1", "stripe is down")).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("never throws when the admin client cannot be created", async () => {
    mockCreateAdminClient.mockImplementationOnce(() => {
      throw new Error("down");
    });

    await expect(failWebhookEvent("evt_1", "stripe is down")).resolves.toBeUndefined();
  });
});
