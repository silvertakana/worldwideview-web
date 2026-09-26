import { describe, it, expect } from 'vitest'
import {
  BILLING_FAILURES_TABLE,
  SAMPLE_LIMIT,
  UNFINISHED_EVENT_THRESHOLD_MS,
  WEBHOOK_EVENTS_TABLE,
  gradeDurableQueues,
  readDurableQueues,
  summarizeUnfinishedEvents,
  summarizeUnresolvedFailures,
} from './billing-durable-queues.mjs'

/**
 * The two queues hold payments that arrived and did not finish. Comparing Stripe
 * against the ledger cannot see such a row - it is missing from both lists - so
 * this module is the only thing standing between a stranded payment and a green
 * run. None of its promises is left to reasoning:
 *
 *   1. It reads; it never writes. Every statement it issues is a SELECT.
 *   2. An absent table, an empty queue and an unreadable answer are three
 *      different results, and none of them is allowed to look like another.
 *   3. An event unfinished past the limit fails; an event that cannot be aged
 *      says so instead of being rounded to fine.
 *   4. The COUNT is exact and the printed list never is, so a bounded sample can
 *      never be read as the total.
 *
 * The reporting half is pure - rows in, report out - so everything below is a
 * fixture: no database, no clock beyond the `now` each case injects.
 */

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown }>

/** The real migration's columns for webhook_events, once 20260915140000 is applied. */
const EXTENDED_EVENT_COLUMNS = ['id', 'event_id', 'processed_at', 'last_error', 'last_attempt_at']

/** The same table with only half of 20260915140000 applied: nullable, but no stamp. */
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

  it('names an identity column only when the catalogue returned that name', async () => {
    // The catalogue is data that came out of the database, so a name in it is
    // untrusted input to a query string. Only the names this module wrote, and
    // only when the catalogue confirms the table has them, may be interpolated;
    // everything else becomes a NULL with the right name, which keeps the row
    // shape identical without trusting anything.
    const stub = queryStub({
      columns: catalogTables(
        [...PARTIAL_EVENT_COLUMNS, 'email; DROP TABLE billing_failures --'],
        [
          'stage',
          'attempts',
          'first_seen_at',
          'resolved_at',
          'email; DROP TABLE billing_failures --',
          'event_type) FROM public.billing_failures; --',
        ],
      ),
      failures: [{ stage: 'provision', attempts: 1, first_seen_at: minutesBefore(60) }],
    })
    const reading = await readDurableQueues(stub.impl)

    const failuresSql = stub.sql.find((statement) => statement.includes('FROM public.billing_failures'))
    expect(failuresSql).toContain('NULL::text AS event_type')
    expect(failuresSql).toContain('NULL::text AS email')
    expect(failuresSql).not.toContain('DROP TABLE')
    expect(failuresSql).not.toContain('; --')
    expect(reading.problems).toEqual([])
    expect(reading.unresolvedFailures[0].identity).toBe('(unidentified)')
  })

  it('refuses a failure row whose attempts value is not a number', async () => {
    const stub = queryStub({ failures: [{ stage: 'provision', attempts: '3', first_seen_at: minutesBefore(60) }] })
    const reading = await readDurableQueues(stub.impl)

    expect(reading.problems[0]).toContain('non-numeric attempts value')
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
    // Nothing was left unread and nothing was left unmeasurable, so this is a
    // complete answer and the runner may report agreement.
    expect(verdict.complete).toBe(true)
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
    // The exit code stays 0, but the answer is not complete: an operator must not
    // be able to read this run as "the queues are fine".
    expect(verdict.complete).toBe(false)
  })

  it('warns only about the table that is actually missing', async () => {
    const verdict = await read({ columns: catalogTables(EXTENDED_EVENT_COLUMNS, null) })

    expect(verdict.warnings).toHaveLength(1)
    expect(verdict.warnings[0]).toContain(BILLING_FAILURES_TABLE)
    expect(verdict.complete).toBe(false)
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
    expect(verdict.complete).toBe(false)
  })

  it('says no migration brings the stamp back when the column exists and the row has none', async () => {
    // This shape has last_attempt_at, and this row is NULL in it. That is a claim
    // whose handler recorded no attempt, NOT a column waiting for a migration -
    // and naming the wrong fix sends an operator looking for a deploy that is
    // not missing.
    const verdict = await read({ events: [{ event_id: 'evt_no_stamp', last_attempt_at: null }] })

    expect(verdict.warnings[0]).toContain('recorded no attempt at all')
    expect(verdict.warnings[0]).toContain('No migration adds that stamp back')
    expect(verdict.warnings[0]).not.toContain('rest of the webhook_events migration')
  })

  it('says the migration is the fix when this schema has no attempt column at all', async () => {
    const verdict = await read({
      columns: catalogTables(PARTIAL_EVENT_COLUMNS, FAILURE_COLUMNS),
      events: [{ event_id: 'evt_unaged' }],
    })

    expect(verdict.warnings[0]).toContain('no last_attempt_at column')
    expect(verdict.warnings[0]).toContain('rest of the webhook_events migration')
    expect(verdict.warnings[0]).not.toContain('recorded no attempt at all')
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

describe('summarizeUnfinishedEvents', () => {
  const HOUR = 60 * 60 * 1000
  const ago = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString()

  const event = (over: Record<string, unknown> = {}) => ({
    eventId: 'evt_1',
    lastAttemptAt: ago(3 * HOUR),
    lastError: 'handler threw',
    email: 'stuck@example.com',
    userId: 'user-9',
    ...over,
  })

  it('reports nothing for an empty queue', () => {
    expect(summarizeUnfinishedEvents([], NOW)).toEqual({
      count: 0,
      thresholdMs: UNFINISHED_EVENT_THRESHOLD_MS,
      oldestAgeMs: null,
      sample: [],
    })
  })

  it('reports an event that has made no progress for hours', () => {
    const result = summarizeUnfinishedEvents([event()], NOW)

    expect(result.count).toBe(1)
    expect(result.oldestAgeMs).toBe(3 * HOUR)
    expect(result.sample[0]).toEqual({
      eventId: 'evt_1',
      lastAttemptAt: ago(3 * HOUR),
      lastError: 'handler threw',
      email: 'stuck@example.com',
      userId: 'user-9',
      ageMs: 3 * HOUR,
    })
  })

  it('does not report an event exactly at the 15-minute threshold', () => {
    const result = summarizeUnfinishedEvents(
      [event({ lastAttemptAt: ago(UNFINISHED_EVENT_THRESHOLD_MS) })],
      NOW,
    )
    expect(result.count).toBe(0)
  })

  it('reports an event one millisecond past the threshold', () => {
    const result = summarizeUnfinishedEvents(
      [event({ lastAttemptAt: ago(UNFINISHED_EVENT_THRESHOLD_MS + 1) })],
      NOW,
    )
    expect(result.count).toBe(1)
  })

  it('measures the threshold in minutes, because that is what the run reports', () => {
    // The alert says "past the 15m limit", and this constant is the one number
    // that sentence and the comparison both come from.
    expect(UNFINISHED_EVENT_THRESHOLD_MS).toBe(15 * 60 * 1000)

    const justInside = summarizeUnfinishedEvents([event({ lastAttemptAt: ago(15 * 60_000 - 1) })], NOW)
    const justOutside = summarizeUnfinishedEvents([event({ lastAttemptAt: ago(15 * 60_000 + 1) })], NOW)

    expect(justInside.count).toBe(0)
    expect(justOutside.count).toBe(1)
  })

  it('leaves a still-recent failure alone, since Stripe is probably retrying it', () => {
    const result = summarizeUnfinishedEvents([event({ lastAttemptAt: ago(5 * 60 * 1000) })], NOW)
    expect(result.count).toBe(0)
  })

  it('skips rows with no attempt timestamp rather than guessing at their age', () => {
    // Documented blind spot: claimed-but-never-failed rows cannot be told apart
    // from one claimed a second ago, because the ledger has no claim timestamp.
    const result = summarizeUnfinishedEvents(
      [event({ lastAttemptAt: null }), event({ lastAttemptAt: undefined })],
      NOW,
    )
    expect(result.count).toBe(0)
    expect(result.oldestAgeMs).toBeNull()
  })

  it('skips an unparseable timestamp instead of treating it as ancient', () => {
    expect(summarizeUnfinishedEvents([event({ lastAttemptAt: 'not a date' })], NOW).count).toBe(0)
  })

  it('accepts a Date, an ISO string, or epoch milliseconds', () => {
    const asDate = summarizeUnfinishedEvents([event({ lastAttemptAt: new Date(NOW.getTime() - 3 * HOUR) })], NOW)
    const asIso = summarizeUnfinishedEvents([event({ lastAttemptAt: ago(3 * HOUR) })], NOW)
    const asMillis = summarizeUnfinishedEvents([event({ lastAttemptAt: NOW.getTime() - 3 * HOUR })], NOW)

    expect(asDate.count).toBe(1)
    expect(asIso.count).toBe(1)
    expect(asMillis.count).toBe(1)
    // One rendering whatever the input shape, so a log line does not change with
    // whatever the driver handed back.
    expect(asDate.sample[0].lastAttemptAt).toBe(ago(3 * HOUR))
    expect(asMillis.sample[0].lastAttemptAt).toBe(ago(3 * HOUR))
  })

  it('keeps the count exact while bounding the sample, oldest first', () => {
    // Ages run 2h .. 26h, so every fixture is well past the 15m threshold.
    const events = Array.from({ length: SAMPLE_LIMIT + 5 }, (_, index) =>
      event({ eventId: `evt_${index}`, lastAttemptAt: ago((index + 2) * HOUR) }),
    )

    const result = summarizeUnfinishedEvents(events, NOW)

    expect(result.count).toBe(SAMPLE_LIMIT + 5)
    expect(result.sample).toHaveLength(SAMPLE_LIMIT)
    // index 0 is the most recent of the batch, so the oldest is the last one.
    expect(result.sample[0].eventId).toBe(`evt_${SAMPLE_LIMIT + 4}`)
    expect(result.sample[0].ageMs).toBe(26 * HOUR)
    expect(result.oldestAgeMs).toBe(26 * HOUR)
  })

  it('honours a custom threshold', () => {
    const events = [event({ lastAttemptAt: ago(2 * HOUR) })]
    expect(summarizeUnfinishedEvents(events, NOW, HOUR).count).toBe(1)
    expect(summarizeUnfinishedEvents(events, NOW, 5 * HOUR).count).toBe(0)
    expect(summarizeUnfinishedEvents(events, NOW, HOUR).thresholdMs).toBe(HOUR)
  })
})

describe('summarizeUnresolvedFailures', () => {
  const HOUR = 60 * 60 * 1000
  const ago = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString()

  const failure = (over: Record<string, unknown> = {}) => ({
    id: 'fail-1',
    userId: 'user-1',
    email: 'broken@example.com',
    eventId: 'evt_1',
    eventType: 'checkout.session.completed',
    stage: 'provision',
    attempts: 3,
    firstSeenAt: ago(48 * HOUR),
    lastAttemptAt: ago(47 * HOUR),
    ...over,
  })

  it('reports nothing for an empty queue', () => {
    expect(summarizeUnresolvedFailures([], NOW)).toEqual({
      count: 0,
      byStage: [],
      oldestAgeMs: null,
      sample: [],
    })
  })

  it('reports an unresolved failure with its stage and identity', () => {
    const result = summarizeUnresolvedFailures([failure()], NOW)

    expect(result.count).toBe(1)
    expect(result.sample[0]).toMatchObject({
      stage: 'provision',
      identity: 'broken@example.com',
      email: 'broken@example.com',
      eventId: 'evt_1',
      eventType: 'checkout.session.completed',
      attempts: 3,
      // ageMs is time OPEN (48h since first_seen), not time since the last try.
      ageMs: 48 * HOUR,
      sinceLastAttemptMs: 47 * HOUR,
    })
  })

  it('never reports a resolved failure, even if the caller passes one', () => {
    const result = summarizeUnresolvedFailures(
      [failure(), failure({ id: 'fail-2', resolvedAt: ago(HOUR) })],
      NOW,
    )
    expect(result.count).toBe(1)
    expect(result.sample[0].id).toBe('fail-1')
  })

  it('falls back through email, user id, event id, then row id', () => {
    const identity = (over: Record<string, unknown>) =>
      summarizeUnresolvedFailures([failure(over)], NOW).sample[0].identity

    expect(identity({ email: 'a@example.com' })).toBe('a@example.com')
    expect(identity({ email: null })).toBe('user-1')
    expect(identity({ email: null, userId: null })).toBe('evt_1')
    expect(identity({ email: null, userId: null, eventId: null })).toBe('fail-1')
    expect(identity({ email: null, userId: null, eventId: null, id: null })).toBe('(unidentified)')
  })

  it('tallies by stage, most frequent first and alphabetical on a tie', () => {
    const result = summarizeUnresolvedFailures(
      [
        failure({ id: 'a', stage: 'provision' }),
        failure({ id: 'b', stage: 'tier_sync' }),
        failure({ id: 'c', stage: 'provision' }),
      ],
      NOW,
    )

    expect(result.count).toBe(3)
    expect(result.byStage).toEqual([
      ['provision', 2],
      ['tier_sync', 1],
    ])

    // Pairs rather than a keyed object, and a stable order even when the counts
    // match: two runs over the same rows must print the same line.
    const tied = summarizeUnresolvedFailures(
      [failure({ id: 'a', stage: 'tier_sync' }), failure({ id: 'b', stage: 'provision' })],
      NOW,
    )
    expect(tied.byStage).toEqual([
      ['provision', 1],
      ['tier_sync', 1],
    ])
  })

  it('orders the sample oldest first, whichever order the rows arrived in', () => {
    const result = summarizeUnresolvedFailures(
      [
        failure({ id: 'newer', firstSeenAt: ago(2 * HOUR) }),
        failure({ id: 'oldest', firstSeenAt: ago(72 * HOUR) }),
        failure({ id: 'middle', firstSeenAt: ago(24 * HOUR) }),
      ],
      NOW,
    )

    expect(result.sample.map((item) => item.id)).toEqual(['oldest', 'middle', 'newer'])
    // The longest-broken failure is the one costing a customer the most.
    expect(result.oldestAgeMs).toBe(72 * HOUR)
  })

  it('keeps the count exact while bounding the sample', () => {
    const failures = Array.from({ length: SAMPLE_LIMIT + 4 }, (_, index) =>
      failure({ id: `fail_${index}`, firstSeenAt: ago((index + 1) * HOUR) }),
    )

    const result = summarizeUnresolvedFailures(failures, NOW)

    expect(result.count).toBe(SAMPLE_LIMIT + 4)
    expect(result.sample).toHaveLength(SAMPLE_LIMIT)
  })

  it('survives a row missing the fields it reports on', () => {
    const result = summarizeUnresolvedFailures(
      [failure({ stage: null, attempts: null, firstSeenAt: null, lastAttemptAt: null })],
      NOW,
    )

    expect(result.count).toBe(1)
    expect(result.sample[0].stage).toBe('(no stage)')
    expect(result.sample[0].attempts).toBeNull()
    expect(result.sample[0].ageMs).toBeNull()
    expect(result.sample[0].sinceLastAttemptMs).toBeNull()
    expect(result.sample[0].identity).toBe('broken@example.com')
    expect(result.byStage).toEqual([['(no stage)', 1]])
  })

  it('refuses to measure against a now it cannot read instead of reporting nothing', () => {
    // An Invalid Date is what a broken clock produces, and every age would be NaN
    // against it - NaN fails every comparison, which would report an empty queue
    // for a queue nobody actually measured. A programming error is thrown, not
    // smoothed over.
    expect(() => summarizeUnresolvedFailures([failure()], new Date('not a clock'))).toThrow(
      /not a Date, an ISO string or epoch milliseconds/,
    )
  })
})
