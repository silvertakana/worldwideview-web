import { describe, it, expect, vi } from 'vitest'
import {
  BILLING_FAILURES_TABLE,
  UNFINISHED_EVENT_THRESHOLD_MS,
  WEBHOOK_EVENTS_TABLE,
  gradeDurableQueues,
  readDurableQueues,
} from './billing-durable-queues.mjs'

/**
 * The two queues hold payments that arrived and did not finish. Comparing Stripe
 * against the ledger cannot see such a row - it is missing from both lists - so
 * this reader is the only thing standing between a stranded payment and a green
 * run. Its guarantees are pinned here rather than reasoned about:
 *
 *   1. It reads; it never writes. Every statement it issues is a SELECT.
 *   2. An absent table, an empty queue and an unreadable answer are three
 *      different results, and none of them is allowed to look like another.
 *   3. An event unfinished past the limit fails; an event that cannot be aged
 *      says so instead of being rounded to fine.
 */

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown }>

/** The real migration's columns for webhook_events, once 20260915000001 is applied. */
const EXTENDED_EVENT_COLUMNS = ['id', 'event_id', 'processed_at', 'last_error', 'last_attempt_at']

/** The same table with only half of 20260915000001 applied: nullable, but no stamp. */
const PARTIAL_EVENT_COLUMNS = ['id', 'event_id', 'processed_at']

const FAILURE_COLUMNS = [
  'id',
  'user_id',
  'email',
  'event_id',
  'event_type',
  'stage',
  'error',
  'attempts',
  'first_seen_at',
  'last_attempt_at',
  'resolved_at',
]

/** The catalogue rows the real query returns, built without a computed key. */
function catalogTables(
  eventColumns: string[] | null,
  failureColumns: string[] | null,
): Array<{ table_name: string; column_name: string }> {
  const rows: Array<{ table_name: string; column_name: string }> = []
  for (const column_name of eventColumns ?? []) {
    rows.push({ table_name: WEBHOOK_EVENTS_TABLE, column_name })
  }
  for (const column_name of failureColumns ?? []) {
    rows.push({ table_name: BILLING_FAILURES_TABLE, column_name })
  }
  return rows
}

const bothTables = () => catalogTables(EXTENDED_EVENT_COLUMNS, FAILURE_COLUMNS)

type QueueFixture = {
  columns?: unknown
  events?: unknown
  failures?: unknown
}

/** Routes each statement to the table it names and records every statement. */
function queryStub(fixture: QueueFixture = {}) {
  const sql: string[] = []
  const impl: QueryFn = async (text) => {
    sql.push(text)
    if (text.includes('pg_catalog.pg_class')) return { rows: fixture.columns ?? bothTables() }
    if (text.includes('FROM public.webhook_events')) return { rows: fixture.events ?? [] }
    if (text.includes('FROM public.billing_failures')) return { rows: fixture.failures ?? [] }
    return { rows: [] }
  }
  return { impl, sql }
}

/** Grading is time-dependent, so every test pins the clock. */
const NOW = new Date('2026-09-15T06:00:00.000Z')
const minutesBefore = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString()

describe('readDurableQueues', () => {
  it('issues only SELECT statements', async () => {
    const stub = queryStub()
    await readDurableQueues(stub.impl)

    expect(stub.sql.length).toBeGreaterThan(0)
    expect(stub.sql.every((statement) => /^\s*SELECT/i.test(statement))).toBe(true)
  })

  it('reads the extended shape when last_attempt_at is present', async () => {
    const stub = queryStub({ events: [] })
    await readDurableQueues(stub.impl)

    const eventsSql = stub.sql.find((statement) => statement.includes('FROM public.webhook_events'))
    expect(eventsSql).toContain('last_attempt_at')
    expect(eventsSql).toContain('last_error')
  })

  it('reads the stamp-less shape when the migration is half applied', async () => {
    const stub = queryStub({ columns: catalogTables(PARTIAL_EVENT_COLUMNS, FAILURE_COLUMNS) })
    const reading = await readDurableQueues(stub.impl)

    const eventsSql = stub.sql.find((statement) => statement.includes('FROM public.webhook_events'))
    expect(eventsSql).not.toContain('last_attempt_at')
    expect(reading.canAgeEvents).toBe(false)
  })

  it('reports an absent table as absent rather than as an empty queue', async () => {
    const stub = queryStub({ columns: [] })
    const reading = await readDurableQueues(stub.impl)

    expect(reading.absentTables).toEqual([WEBHOOK_EVENTS_TABLE, BILLING_FAILURES_TABLE])
    expect(stub.sql.some((statement) => statement.includes('FROM public.webhook_events'))).toBe(false)
  })

  it('reads neither table when the catalogue itself is unreadable', async () => {
    const stub = queryStub({ columns: 'not-rows' })

    await expect(readDurableQueues(stub.impl)).rejects.toThrow(/column catalogue/)
  })
})

describe('gradeDurableQueues', () => {
  const read = async (fixture: QueueFixture) => {
    const stub = queryStub(fixture)
    return gradeDurableQueues(await readDurableQueues(stub.impl), NOW)
  }

  it('is clean when both queues are empty', async () => {
    const verdict = await read({})

    expect(verdict.failures).toEqual([])
    expect(verdict.warnings).toEqual([])
    expect(verdict.ok).toBe(true)
  })

  it('warns unmistakably when the tables are not deployed, without failing', async () => {
    const verdict = await read({ columns: [] })

    expect(verdict.ok).toBe(true)
    expect(verdict.failures).toEqual([])
    expect(verdict.warnings).toHaveLength(2)
    expect(verdict.warnings[0]).toContain(`${WEBHOOK_EVENTS_TABLE} does not exist`)
    expect(verdict.warnings[0]).toContain('NOT read')
    expect(verdict.warnings[0]).toContain('NOT a clean result')
    expect(verdict.warnings[1]).toContain(`${BILLING_FAILURES_TABLE} does not exist`)
  })

  it('warns only about the table that is actually missing', async () => {
    const verdict = await read({ columns: catalogTables(EXTENDED_EVENT_COLUMNS, null) })

    expect(verdict.warnings).toHaveLength(1)
    expect(verdict.warnings[0]).toContain(BILLING_FAILURES_TABLE)
  })

  it('fails on an event unfinished past the limit, naming its age and last_error', async () => {
    const verdict = await read({
      events: [
        { event_id: 'evt_stuck', last_error: 'tier sync timed out', last_attempt_at: minutesBefore(30) },
      ],
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.failures).toHaveLength(1)
    expect(verdict.failures[0]).toContain('evt_stuck')
    expect(verdict.failures[0]).toContain('unfinished for 30m')
    expect(verdict.failures[0]).toContain('tier sync timed out')
  })

  it('says nothing is recorded when the stuck row carries no last_error', async () => {
    const verdict = await read({
      events: [{ event_id: 'evt_stuck', last_error: null, last_attempt_at: minutesBefore(600) }],
    })

    expect(verdict.failures[0]).toContain('10h 0m')
    expect(verdict.failures[0]).toContain('(none recorded')
  })

  it('does not fail on an event that is still inside the window', async () => {
    const verdict = await read({
      events: [{ event_id: 'evt_flight', last_error: null, last_attempt_at: minutesBefore(5) }],
    })

    expect(verdict.ok).toBe(true)
    expect(verdict.failures).toEqual([])
  })

  it('treats the threshold as the boundary and not as a hair-trigger', async () => {
    const atLimit = await read({
      events: [
        {
          event_id: 'evt_edge',
          last_error: null,
          last_attempt_at: new Date(NOW.getTime() - UNFINISHED_EVENT_THRESHOLD_MS).toISOString(),
        },
      ],
    })

    expect(atLimit.ok).toBe(true)
  })

  it('warns rather than fails when an unfinished row cannot be aged at all', async () => {
    const verdict = await read({ events: [{ event_id: 'evt_no_stamp' }] })

    expect(verdict.ok).toBe(true)
    expect(verdict.failures).toEqual([])
    expect(verdict.warnings).toHaveLength(1)
    expect(verdict.warnings[0]).toContain('no attempt timestamp to age them against')
    expect(verdict.warnings[0]).toContain('evt_no_stamp')
    expect(verdict.warnings[0]).toContain('INCOMPLETE')
  })

  it('fails on unresolved failures, reporting the count, the stages and the oldest age', async () => {
    const verdict = await read({
      failures: [
        { stage: 'provision', attempts: 3, first_seen_at: minutesBefore(60 * 24 * 14 + 360) },
        { stage: 'tier_sync', attempts: 1, first_seen_at: minutesBefore(60) },
      ],
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.failures).toHaveLength(1)
    expect(verdict.failures[0]).toContain('2 unresolved failure(s)')
    expect(verdict.failures[0]).toContain('stages: provision=1, tier_sync=1')
    expect(verdict.failures[0]).toContain('oldest 14d 6h')
  })

  it('fails when a queue that exists cannot be read', async () => {
    const verdict = await read({ events: 'not-rows' })

    expect(verdict.ok).toBe(false)
    expect(verdict.failures[0]).toContain(`${WEBHOOK_EVENTS_TABLE} returned something this reader cannot interpret`)
    expect(verdict.failures[0]).toContain('Unknown is not empty')
  })

  it('fails when a timestamp is present but cannot be read', async () => {
    const verdict = await read({
      events: [{ event_id: 'evt_bad_stamp', last_error: null, last_attempt_at: 'yesterday-ish' }],
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.failures[0]).toContain('unreadable last_attempt_at for evt_bad_stamp')
  })

  it('fails rather than skips a row it cannot identify', async () => {
    const verdict = await read({ events: [{ last_attempt_at: minutesBefore(30) }] })

    expect(verdict.ok).toBe(false)
    expect(verdict.failures[0]).toContain('no usable event_id')
  })

  it('fails when billing_failures exists in a shape it does not know', async () => {
    const verdict = await read({ columns: catalogTables(EXTENDED_EVENT_COLUMNS, ['id', 'stage']) })

    expect(verdict.ok).toBe(false)
    expect(verdict.failures[0]).toContain(`${BILLING_FAILURES_TABLE} exists but has no`)
  })

  it('fails when a failure row carries an unreadable attempts value', async () => {
    const verdict = await read({
      failures: [{ stage: 'provision', attempts: '3', first_seen_at: minutesBefore(60) }],
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.failures[0]).toContain('non-numeric attempts value')
  })

  it('reports both queues at once when both are holding something', async () => {
    const verdict = await read({
      events: [{ event_id: 'evt_stuck', last_error: null, last_attempt_at: minutesBefore(30) }],
      failures: [{ stage: 'resolve', attempts: 1, first_seen_at: minutesBefore(120) }],
    })

    expect(verdict.failures).toHaveLength(2)
    expect(verdict.failures[0]).toContain('evt_stuck')
    expect(verdict.failures[1]).toContain('stages: resolve=1')
  })
})
