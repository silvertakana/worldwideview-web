import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { main } from './billing-reconcile.mjs'
import { MAX_SWEEP_ROUNDS, TIER_LOCK_SWEEP_PATH } from './lib/globe-tier-lock-sweep.mjs'
import {
  BILLING_FAILURES_TABLE,
  SAMPLE_LIMIT,
  WEBHOOK_EVENTS_TABLE,
} from './lib/billing-durable-queues.mjs'

/**
 * Drives the runner end to end against a stubbed database and a stubbed Stripe,
 * so the parts that cannot be reasoned about from the pure halves are actually
 * executed: pagination, the exit code, the sweep phase, the reporting of both
 * durable queues, and the fact that a queue which cannot be READ is never
 * allowed to look like an empty one.
 *
 * The stub routes each statement to the table it names. A blanket
 * `pool.query.mockResolvedValue(...)` would answer the queue reads with ledger
 * rows, which is exactly the kind of accident that hides a broken reader, so
 * every test states the rows it means.
 */

const pool = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn() }))

vi.mock('pg', () => ({
  Pool: class MockPool {
    query(...args: unknown[]) {
      return pool.query(...args)
    }
    end() {
      return pool.end()
    }
  },
}))

const STRIPE_BASE = 'https://stripe.test/v1'
const GLOBE_BASE = 'https://globe.test'
const CROSS_SERVICE_SECRET_VALUE = 'test-cross-service-secret'
const PERIOD_END_SECONDS = Math.floor(Date.parse('2026-10-01T00:00:00.000Z') / 1000)

type StripePage = { data: Array<Record<string, unknown>>; has_more: boolean }

/** Serves each Stripe list path from a queue of pages, and records every call. */
function stripeStub(pages: Map<string, StripePage[]>) {
  const requested: string[] = []
  const methods: string[] = []
  const cursor = new Map<string, number>()
  const impl = async (input: string | URL, init?: { method?: string }) => {
    const url = new URL(String(input))
    requested.push(`${url.pathname}?${url.searchParams.toString()}`)
    methods.push(init?.method ?? 'GET')
    const index = cursor.get(url.pathname) ?? 0
    cursor.set(url.pathname, index + 1)
    const page = pages.get(url.pathname)?.[index] ?? { data: [], has_more: false }
    return { ok: true, status: 200, text: async () => '', json: async () => page }
  }
  return { impl, requested, methods }
}

type SweepReply = { status?: number; body: unknown }

/**
 * Routes the globe sweep to its own queue and everything else to the Stripe
 * stub, so one test can drive both halves of a run.
 */
function combinedStub(pages: Map<string, StripePage[]>, sweepReplies: SweepReply[] = []) {
  const stripe = stripeStub(pages)
  const sweepCalls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = []
  let sweepIndex = 0
  const impl = async (
    input: string | URL,
    init?: { method?: string; headers?: Record<string, string>; body?: unknown },
  ) => {
    const url = new URL(String(input))
    if (url.pathname !== TIER_LOCK_SWEEP_PATH) return stripe.impl(input, init)
    sweepCalls.push({
      url: url.pathname,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body,
    })
    const reply = sweepReplies[sweepIndex] ?? sweepReplies[sweepReplies.length - 1] ?? {
      body: { success: true, due: 0, locked: 0, unapplied: 0, failed: 0, hasMore: false },
    }
    sweepIndex += 1
    const status = reply.status ?? 200
    return { ok: status === 200, text: async () => JSON.stringify(reply.body) }
  }
  return { impl, sweepCalls, stripe }
}

const customer = (id: string, email: string) => ({ id, email })

const subscription = (over: Record<string, unknown> = {}) => ({
  id: 'sub_1',
  customer: 'cus_1',
  status: 'active',
  current_period_end: PERIOD_END_SECONDS,
  items: { data: [{ price: { id: 'price_pro_month', recurring: { interval: 'month' } } }] },
  ...over,
})

/** Matches the row the fixtures above describe, with a Date for the timestamp. */
const ledgerRow = (over: Record<string, unknown> = {}) => ({
  user_id: 'user-1',
  email: 'subscriber@example.com',
  stripe_customer_id: 'cus_1',
  stripe_subscription_id: 'sub_1',
  price_id: 'price_pro_month',
  plan: 'pro',
  interval: 'month',
  status: 'active',
  stripe_status: 'active',
  current_period_end: new Date('2026-10-01T00:00:00.000Z'),
  source: 'stripe',
  ...over,
})

/** The columns the two migrations give webhook_events and billing_failures. */
const EVENT_COLUMNS = ['id', 'event_id', 'processed_at', 'last_error', 'last_attempt_at', 'email', 'user_id']
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

/** webhook_events with half of 20260915000001 applied: nullable, but no stamp. */
const PARTIAL_EVENT_COLUMNS = ['id', 'event_id', 'processed_at']

/** The catalogue rows for the deployed shape, built without a computed key. */
function catalogTables(eventColumns: string[] | null, failureColumns: string[] | null) {
  const rows: Array<{ table_name: string; column_name: string }> = []
  for (const column_name of eventColumns ?? []) {
    rows.push({ table_name: WEBHOOK_EVENTS_TABLE, column_name })
  }
  for (const column_name of failureColumns ?? []) {
    rows.push({ table_name: BILLING_FAILURES_TABLE, column_name })
  }
  return rows
}

const bothTables = () => catalogTables(EVENT_COLUMNS, FAILURE_COLUMNS)

type QueueFixture = {
  ledger?: Array<Record<string, unknown>>
  columns?: unknown
  events?: unknown
  failures?: unknown
  /** The phase whose read should throw, for the "could not look is not zero" cases. */
  fail?: 'ledger' | 'catalogue' | 'events' | 'failures'
  /** Every statement the run issued, so a test can assert what was actually asked. */
  sql?: string[]
}

/**
 * Routes every statement to the table it names.
 *
 * The default catalogue is the deployed shape, so a test only says "absent" when
 * it means it. `fail` throws from inside the reader, which is what a real
 * connection error does, so those cases pin that a read that could not happen is
 * never quietly reported as an empty queue.
 */
function routeQuery(fixture: QueueFixture = {}) {
  return async (text: string) => {
    fixture.sql?.push(text)
    if (text.includes('FROM public.billing_subscriptions')) {
      if (fixture.fail === 'ledger') throw new Error('relation "public.billing_subscriptions" does not exist')
      return { rows: fixture.ledger ?? [] }
    }
    if (text.includes('pg_catalog.pg_class')) {
      if (fixture.fail === 'catalogue') throw new Error('pg_catalog did not answer')
      return { rows: fixture.columns ?? bothTables() }
    }
    if (text.includes('FROM public.webhook_events')) {
      if (fixture.fail === 'events') throw new Error('relation "public.webhook_events" does not exist')
      return { rows: fixture.events ?? [] }
    }
    if (text.includes('FROM public.billing_failures')) {
      if (fixture.fail === 'failures') throw new Error('relation "public.billing_failures" does not exist')
      return { rows: fixture.failures ?? [] }
    }
    return { rows: [] }
  }
}

/** Everything the run printed, read back from the spy beforeEach installs. */
function logLines(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => call.map(String).join(' '))
    .join('\n')
}

/** An instant this many minutes before the run, for the age threshold. */
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

/** A webhook event claimed and never finished, last touched this long ago. */
const unfinishedEvent = (over: Record<string, unknown> = {}) => ({
  event_id: 'evt_stuck',
  last_error: 'tier sync timed out',
  last_attempt_at: minutesAgo(30),
  email: 'stuck@example.com',
  user_id: 'user-9',
  ...over,
})

/** An unresolved billing failure: durable, unread, and waiting for a person. */
const unresolvedFailure = (over: Record<string, unknown> = {}) => ({
  id: 'fail-1',
  user_id: 'user-1',
  email: 'broken@example.com',
  event_id: 'evt_1',
  event_type: 'checkout.session.completed',
  stage: 'provision',
  error: 'globe returned 500',
  attempts: 2,
  first_seen_at: minutesAgo(90),
  last_attempt_at: minutesAgo(85),
  resolved_at: null,
  ...over,
})

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  vi.restoreAllMocks()
  pool.query.mockReset()
  pool.end.mockReset()
  pool.end.mockResolvedValue(undefined)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  process.env.SUPABASE_DB_URL = 'postgres://runner@db.test:5432/postgres'
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
  process.env.STRIPE_BASE_URL = STRIPE_BASE
  // Empty rather than deleted: an empty value is falsy to the sweep module and
  // is never re-filled from a .env file by the runner's loader.
  process.env.CROSS_SERVICE_SECRET = ''
  process.env.WWV_GLOBE_URL = GLOBE_BASE
})

afterEach(() => {
  vi.unstubAllGlobals()
  process.env = { ...ORIGINAL_ENV }
})

const agreeingStripe = () =>
  stripeStub(
    new Map([
      ['/v1/customers', [{ data: [customer('cus_1', 'subscriber@example.com')], has_more: false }]],
      ['/v1/subscriptions', [{ data: [subscription()], has_more: false }]],
    ]),
  )

describe('billing-reconcile runner: the comparison', () => {
  it('exits 0 when the ledger and Stripe agree', async () => {
    pool.query.mockImplementation(routeQuery({ ledger: [ledgerRow()] }))
    const stripe = agreeingStripe()
    vi.stubGlobal('fetch', stripe.impl)

    await expect(main()).resolves.toBe(0)
    expect(pool.end).toHaveBeenCalled()
  })

  it('reads both queues on every run, including a healthy one', async () => {
    const sql: string[] = []
    pool.query.mockImplementation(routeQuery({ ledger: [ledgerRow()], sql }))
    vi.stubGlobal('fetch', agreeingStripe().impl)

    await expect(main()).resolves.toBe(0)

    // A healthy run is exactly when the queues are easiest to forget: the ledger
    // and Stripe agree, so nothing else in this script would ever ask about a
    // payment that arrived and never finished. The read cannot be conditional on
    // drift, or the quiet nights are the ones nobody checks.
    expect(sql.some((statement) => statement.includes('FROM public.billing_failures'))).toBe(true)
    expect(sql.some((statement) => statement.includes('FROM public.webhook_events'))).toBe(true)
    // Only unfinished events are ever in question, and that filter is the query's
    // job rather than something a later step sorts out.
    const eventsSql = sql.find((statement) => statement.includes('FROM public.webhook_events')) ?? ''
    expect(eventsSql).toContain('processed_at IS NULL')
  })

  it('reports both durable queues on every run, zeroes included', async () => {
    const sql: string[] = []
    pool.query.mockImplementation(routeQuery({ ledger: [ledgerRow()], sql }))
    vi.stubGlobal('fetch', agreeingStripe().impl)

    await expect(main()).resolves.toBe(0)

    expect(logLines()).toContain(`${WEBHOOK_EVENTS_TABLE} unfinished=0`)
    expect(logLines()).toContain(`${BILLING_FAILURES_TABLE} unresolved=0`)
    expect(logLines()).toContain('RESULT: no drift. The ledger and Stripe agree.')
    // The one signed request this runner makes is named in the header, so an
    // operator reading "read-only" does not have to take it on trust.
    expect(logLines()).toContain('READ-ONLY EXCEPT FOR THE SWEEP')
    // Only unfinished events are ever in question. A completed event is not a
    // candidate for the queue, and the filter is the query's job.
    const eventsSql = sql.find((statement) => statement.includes('FROM public.webhook_events')) ?? ''
    expect(eventsSql).toContain('processed_at IS NULL')
  })

  it('exits 1 when the two sides disagree', async () => {
    pool.query.mockImplementation(routeQuery({ ledger: [ledgerRow()] }))
    const stripe = stripeStub(
      new Map([
        ['/v1/customers', [{ data: [customer('cus_1', 'subscriber@example.com')], has_more: false }]],
        ['/v1/subscriptions', [{ data: [subscription({ status: 'past_due' })], has_more: false }]],
      ]),
    )
    vi.stubGlobal('fetch', stripe.impl)

    await expect(main()).resolves.toBe(1)
  })

  it('reads every page of every Stripe list', async () => {
    pool.query.mockImplementation(routeQuery({ ledger: [ledgerRow()] }))
    const stripe = stripeStub(
      new Map<string, StripePage[]>([
        [
          '/v1/customers',
          [
            { data: [customer('cus_1', 'subscriber@example.com')], has_more: true },
            { data: [customer('cus_2', 'second@example.com')], has_more: false },
          ],
        ],
        [
          '/v1/subscriptions',
          [
            { data: [subscription()], has_more: true },
            // Only reachable on page two: if the runner stops at the first page
            // this unrecorded, live subscription goes unreported.
            { data: [subscription({ id: 'sub_2', customer: 'cus_2' })], has_more: false },
          ],
        ],
      ]),
    )
    vi.stubGlobal('fetch', stripe.impl)

    await expect(main()).resolves.toBe(1)
    expect(stripe.requested.some((request) => request.includes('starting_after'))).toBe(true)
  })

  it('only ever issues GET requests', async () => {
    pool.query.mockImplementation(routeQuery())
    const stripe = stripeStub(
      new Map([
        ['/v1/customers', [{ data: [], has_more: false }]],
        ['/v1/subscriptions', [{ data: [], has_more: false }]],
      ]),
    )
    vi.stubGlobal('fetch', stripe.impl)

    await expect(main()).resolves.toBe(0)
    expect(stripe.methods.length).toBeGreaterThan(0)
    expect(stripe.methods.every((method) => method === 'GET')).toBe(true)
  })

  it('fails specifically when the database credential is missing', async () => {
    process.env.SUPABASE_DB_URL = ''

    await expect(main()).rejects.toThrow(/SUPABASE_DB_URL is not set/)
  })

  it('fails specifically when the Stripe credential is missing', async () => {
    process.env.STRIPE_SECRET_KEY = ''

    await expect(main()).rejects.toThrow(/STRIPE_SECRET_KEY is not set/)
  })
})

describe('billing-reconcile runner: the two durable queues', () => {
  it('fails when an unfinished webhook event is past the limit', async () => {
    pool.query.mockImplementation(routeQuery({ ledger: [ledgerRow()], events: [unfinishedEvent()] }))
    vi.stubGlobal('fetch', agreeingStripe().impl)

    await expect(main()).resolves.toBe(1)

    expect(logLines()).toContain(`${WEBHOOK_EVENTS_TABLE} unfinished=1`)
    expect(logLines()).toContain('evt_stuck has been unfinished for 30m')
    expect(logLines()).toContain('tier sync timed out')
    // The sample names the row and the account behind it, so the log line alone
    // is enough to start looking.
    expect(logLines()).toContain('  evt_stuck')
    expect(logLines()).toContain('account: stuck@example.com')
    expect(logLines()).toContain('RESULT: no drift between the ledger and Stripe')
  })

  it('fails when billing_failures holds something nobody resolved', async () => {
    const sql: string[] = []
    pool.query.mockImplementation(
      routeQuery({ ledger: [ledgerRow()], failures: [unresolvedFailure()], sql }),
    )
    vi.stubGlobal('fetch', agreeingStripe().impl)

    await expect(main()).resolves.toBe(1)

    expect(logLines()).toContain(`${BILLING_FAILURES_TABLE} unresolved=1`)
    expect(logLines()).toContain('FAILURE')
    expect(logLines()).toContain('1 unresolved failure(s)')
    expect(logLines()).toContain('stages: provision=1')
    // The age of the OLDEST row is the number that decides whether anyone can
    // wait until morning, so the queue line carries it next to the count.
    expect(logLines()).toContain('oldest: 1h 30m')
    // And the row itself prints the identity an operator searches by.
    expect(logLines()).toContain('  [provision] broken@example.com')
    expect(logLines()).toContain('type: checkout.session.completed')
    expect(logLines()).toContain('attempts: 2')
    expect(logLines()).toContain('first seen: ')
    // Resolved rows are excluded by the query, which is the only place a stub
    // cannot fake: nothing downstream filters them again.
    const failuresSql = sql.find((statement) => statement.includes('FROM public.billing_failures')) ?? ''
    expect(failuresSql).toContain('resolved_at IS NULL')
  })

  it('leaves an unfinished event inside the window alone', async () => {
    pool.query.mockImplementation(
      routeQuery({ ledger: [ledgerRow()], events: [unfinishedEvent({ last_attempt_at: minutesAgo(5) })] }),
    )
    vi.stubGlobal('fetch', agreeingStripe().impl)

    // Stripe retries a failed delivery for days, so an event whose last attempt
    // was five minutes ago may still finish on its own.
    await expect(main()).resolves.toBe(0)

    expect(logLines()).toContain(`${WEBHOOK_EVENTS_TABLE} unfinished=1`)
    expect(logLines()).toContain('unfinished past 15m: 0')
    expect(logLines()).not.toContain('evt_stuck')
    expect(logLines()).not.toContain('FAILURE')
  })

  it('treats a run a minute inside the window as nothing to report', async () => {
    // The exact boundary (15m is not stuck, 15m + 1ms is) is pinned in
    // scripts/lib/billing-durable-queues.test.ts, where the clock is injected.
    // Here the clock moves between building this fixture and grading it, so the
    // fixture stays a clear distance inside the window.
    pool.query.mockImplementation(
      routeQuery({ ledger: [ledgerRow()], events: [unfinishedEvent({ last_attempt_at: minutesAgo(14) })] }),
    )
    vi.stubGlobal('fetch', agreeingStripe().impl)

    await expect(main()).resolves.toBe(0)
    expect(logLines()).not.toContain('has been unfinished for')
  })

  it('warns and says INCOMPLETE when an unfinished row carries no attempt timestamp', async () => {
    pool.query.mockImplementation(
      routeQuery({
        ledger: [ledgerRow()],
        events: [unfinishedEvent({ last_attempt_at: null, last_error: null })],
      }),
    )
    vi.stubGlobal('fetch', agreeingStripe().impl)

    // A claim whose handler died before it recorded an attempt cannot be called
    // stuck, and must not be called fine...
    await expect(main()).resolves.toBe(0)

    expect(logLines()).toContain('WARNING')
    expect(logLines()).toContain('INCOMPLETE')
    expect(logLines()).toContain('evt_stuck')
    // ...and the fix named has to be the real one: the column is already here, so
    // sending an operator to look for a missing migration would be a dead end.
    expect(logLines()).toContain('recorded no attempt at all')
    expect(logLines()).not.toContain('rest of the webhook_events migration')
    expect(logLines()).not.toContain('FAILURE')
  })

  it('exits 0 and says INCOMPLETE when webhook_events has no attempt timestamp at all', async () => {
    pool.query.mockImplementation(
      routeQuery({
        ledger: [ledgerRow()],
        columns: catalogTables(PARTIAL_EVENT_COLUMNS, FAILURE_COLUMNS),
        events: [{ event_id: 'evt_unaged' }],
      }),
    )
    vi.stubGlobal('fetch', agreeingStripe().impl)

    await expect(main()).resolves.toBe(0)

    expect(logLines()).toContain('(no attempt timestamp in this schema)')
    expect(logLines()).toContain('rest of the webhook_events migration')
    expect(logLines()).toContain('RESULT: no drift, and no stuck payment found - but this run was INCOMPLETE')
    expect(logLines()).not.toContain('RESULT: no drift. The ledger and Stripe agree.')
  })

  it('treats a webhook_events table absent from the catalogue as NOT DEPLOYED, not as empty', async () => {
    pool.query.mockImplementation(
      routeQuery({ ledger: [ledgerRow()], columns: catalogTables(null, FAILURE_COLUMNS) }),
    )
    vi.stubGlobal('fetch', agreeingStripe().impl)

    // A missing migration is not a billing incident, so the run does not fail...
    await expect(main()).resolves.toBe(0)

    // ...but "there is nowhere to record a stuck payment" is not agreement either.
    expect(logLines()).toContain(`${WEBHOOK_EVENTS_TABLE} NOT DEPLOYED - its queue was not read.`)
    expect(logLines()).toContain(`${BILLING_FAILURES_TABLE} unresolved=0`)
    expect(logLines()).toContain('RESULT: no drift, and no stuck payment found - but this run was INCOMPLETE')
    expect(logLines()).not.toContain('RESULT: no drift. The ledger and Stripe agree.')
  })

  it('succeeds but refuses to call itself clean when the durable tables are not deployed', async () => {
    pool.query.mockImplementation(routeQuery({ ledger: [ledgerRow()], columns: [] }))
    vi.stubGlobal('fetch', agreeingStripe().impl)

    await expect(main()).resolves.toBe(0)

    expect(logLines()).toContain(`${WEBHOOK_EVENTS_TABLE} NOT DEPLOYED`)
    expect(logLines()).toContain(`${BILLING_FAILURES_TABLE} NOT DEPLOYED`)
    expect(logLines()).toContain('does not exist in this database')
    expect(logLines()).toContain('RESULT: no drift, and no stuck payment found - but this run was INCOMPLETE')
    expect(logLines()).not.toContain('RESULT: no drift. The ledger and Stripe agree.')
  })

  it('fails when a durable queue answers with something it cannot read', async () => {
    pool.query.mockImplementation(routeQuery({ ledger: [ledgerRow()], events: 'not-rows' }))
    vi.stubGlobal('fetch', agreeingStripe().impl)

    // "We could not look" is not "there is nothing there".
    await expect(main()).resolves.toBe(1)
    expect(logLines()).toContain('cannot interpret')
  })

  it('reads a failure identity only when the catalogue says this database has one', async () => {
    pool.query.mockImplementation(
      routeQuery({
        ledger: [ledgerRow()],
        // The row is carrying an email, and this database has no email column:
        // the catalogue decides, not the row, because a column the schema does
        // not have cannot be trusted to mean anything.
        columns: catalogTables(EVENT_COLUMNS, ['stage', 'attempts', 'first_seen_at', 'resolved_at']),
        failures: [unresolvedFailure()],
      }),
    )
    vi.stubGlobal('fetch', agreeingStripe().impl)

    await expect(main()).resolves.toBe(1)
    expect(logLines()).toContain('  [provision] (unidentified)')
    expect(logLines()).not.toContain('broken@example.com')
  })

  it('keeps the count exact while the printed sample stays bounded', async () => {
    const failures = Array.from({ length: SAMPLE_LIMIT + 3 }, (_, index) =>
      unresolvedFailure({ id: `fail-${index}`, first_seen_at: minutesAgo(index + 1) }),
    )
    pool.query.mockImplementation(routeQuery({ ledger: [ledgerRow()], failures }))
    vi.stubGlobal('fetch', agreeingStripe().impl)

    await expect(main()).resolves.toBe(1)

    expect(logLines()).toContain(`${BILLING_FAILURES_TABLE} unresolved=23`)
    // A bounded list read as the total is how a backlog of 23 becomes a note
    // about 20.
    expect(logLines()).toContain('showing the 20 oldest of 23')
    expect(logLines()).toContain('23 unresolved failure(s)')
  })

  it('fails loudly when the ledger itself cannot be read', async () => {
    pool.query.mockImplementation(routeQuery({ fail: 'ledger' }))
    vi.stubGlobal('fetch', agreeingStripe().impl)

    await expect(main()).rejects.toThrow(/billing_subscriptions/)
  })

  it('fails loudly when billing_failures cannot be read', async () => {
    pool.query.mockImplementation(routeQuery({ ledger: [ledgerRow()], fail: 'failures' }))
    vi.stubGlobal('fetch', agreeingStripe().impl)

    // Not a clean "0 failures": a queue that could not be read is not empty.
    // Asserted against the one run's error rather than a second run: the Stripe
    // stub hands out its single page once, so a second main() would see an empty
    // Stripe and fail for an unrelated reason.
    await expect(main()).rejects.toThrow(/relation "public\.billing_failures" does not exist/)
  })

  it('fails loudly when webhook_events cannot be read', async () => {
    pool.query.mockImplementation(routeQuery({ ledger: [ledgerRow()], fail: 'events' }))
    vi.stubGlobal('fetch', agreeingStripe().impl)

    await expect(main()).rejects.toThrow(/webhook_events/)
  })

  it('still reports drift when the queues could not be read alongside it', async () => {
    pool.query.mockImplementation(routeQuery({ ledger: [ledgerRow()], fail: 'failures' }))
    const stripe = stripeStub(
      new Map([
        ['/v1/customers', [{ data: [customer('cus_1', 'subscriber@example.com')], has_more: false }]],
        ['/v1/subscriptions', [{ data: [subscription({ status: 'past_due' })], has_more: false }]],
      ]),
    )
    vi.stubGlobal('fetch', stripe.impl)

    // The read failure wins: a queue that could not be READ must not be hidden
    // behind a drift report, whatever the drift would have said.
    await expect(main()).rejects.toThrow(/does not exist/)
  })

  it('fails red when the catalogue itself cannot be interpreted', async () => {
    pool.query.mockImplementation(routeQuery({ ledger: [ledgerRow()], columns: 'not-rows' }))
    vi.stubGlobal('fetch', agreeingStripe().impl)

    // A run that cannot tell an empty queue from a missing table has established
    // nothing, so it must not report either answer - and the CLI turns this throw
    // into exit code 1, printing no RESULT line at all.
    await expect(main()).rejects.toThrow(/column catalogue/)
    expect(logLines()).not.toContain('RESULT: no drift. The ledger and Stripe agree.')
  })

  it('does not let the queue read hide the sweep, or the sweep hide the queue read', async () => {
    pool.query.mockImplementation(
      routeQuery({
        ledger: [ledgerRow()],
        failures: [unresolvedFailure({ stage: 'tier_sync', attempts: 1, first_seen_at: minutesAgo(10) })],
      }),
    )
    process.env.CROSS_SERVICE_SECRET = CROSS_SERVICE_SECRET_VALUE
    const stub = combinedStub(
      new Map([
        ['/v1/customers', [{ data: [customer('cus_1', 'subscriber@example.com')], has_more: false }]],
        ['/v1/subscriptions', [{ data: [], has_more: false }]],
      ]),
      [{ body: { success: true, due: 1, locked: 1, unapplied: 0, failed: 0, hasMore: false } }],
    )
    vi.stubGlobal('fetch', stub.impl)

    await expect(main()).resolves.toBe(1)

    // The sweep still asked the globe, and the queue still failed the run.
    expect(stub.sweepCalls).toHaveLength(1)
    expect(logLines()).toContain('stages: tier_sync=1')
  })
})

describe('billing-reconcile runner: the globe lock sweep', () => {
  it('fails on the missing sweep secret instead of silently skipping the lock phase', async () => {
    pool.query.mockImplementation(routeQuery({ ledger: [ledgerRow()] }))
    const stripe = stripeStub(
      new Map([
        ['/v1/customers', [{ data: [customer('cus_1', 'subscriber@example.com')], has_more: false }]],
        ['/v1/subscriptions', [{ data: [], has_more: false }]],
      ]),
    )
    vi.stubGlobal('fetch', stripe.impl)

    // The ledger grants a plan Stripe no longer backs, so payment has stopped.
    await expect(main()).rejects.toThrow(/CROSS_SERVICE_SECRET is not set/)
  })

  it('does not attempt the lock sweep for drift that is not about payment stopping', async () => {
    pool.query.mockImplementation(routeQuery({ ledger: [ledgerRow()] }))
    const stub = combinedStub(
      new Map([
        ['/v1/customers', [{ data: [customer('cus_1', 'subscriber@example.com')], has_more: false }]],
        // past_due is a disagreement, but it is not a lapse, so no sweep.
        ['/v1/subscriptions', [{ data: [subscription({ status: 'past_due' })], has_more: false }]],
      ]),
    )
    vi.stubGlobal('fetch', stub.impl)

    await expect(main()).resolves.toBe(1)
    expect(stub.sweepCalls).toHaveLength(0)
  })

  it('asks the globe to sweep when a grant has lapsed, and names no account in the request', async () => {
    pool.query.mockImplementation(routeQuery({ ledger: [ledgerRow()] }))
    process.env.CROSS_SERVICE_SECRET = CROSS_SERVICE_SECRET_VALUE
    const stub = combinedStub(
      new Map([
        ['/v1/customers', [{ data: [customer('cus_1', 'subscriber@example.com')], has_more: false }]],
        // Stripe holds nothing for a grant the ledger is still carrying.
        ['/v1/subscriptions', [{ data: [], has_more: false }]],
      ]),
      [{ body: { success: true, due: 1, locked: 1, unapplied: 0, failed: 0, hasMore: false } }],
    )
    vi.stubGlobal('fetch', stub.impl)

    await expect(main()).resolves.toBe(1)

    expect(stub.sweepCalls).toHaveLength(1)
    const call = stub.sweepCalls[0]
    expect(call.url).toBe(TIER_LOCK_SWEEP_PATH)
    expect(call.method).toBe('POST')
    expect(call.body).toBe('')
    expect(JSON.stringify(call)).not.toContain('subscriber@example.com')
  })

  it('re-asks the globe up to the round bound while it reports more work', async () => {
    pool.query.mockImplementation(routeQuery({ ledger: [ledgerRow()] }))
    process.env.CROSS_SERVICE_SECRET = CROSS_SERVICE_SECRET_VALUE
    const stub = combinedStub(
      new Map([
        ['/v1/customers', [{ data: [customer('cus_1', 'subscriber@example.com')], has_more: false }]],
        ['/v1/subscriptions', [{ data: [], has_more: false }]],
      ]),
      [{ body: { success: true, due: 500, locked: 500, unapplied: 0, failed: 0, hasMore: true } }],
    )
    vi.stubGlobal('fetch', stub.impl)

    await expect(main()).rejects.toThrow(/still reports hasMore/)
    expect(stub.sweepCalls).toHaveLength(MAX_SWEEP_ROUNDS)
  })

  it('fails when the globe answer omits a count, naming the count it never got', async () => {
    pool.query.mockImplementation(routeQuery({ ledger: [ledgerRow()] }))
    process.env.CROSS_SERVICE_SECRET = CROSS_SERVICE_SECRET_VALUE
    const stub = combinedStub(
      new Map([
        ['/v1/customers', [{ data: [customer('cus_1', 'subscriber@example.com')], has_more: false }]],
        ['/v1/subscriptions', [{ data: [], has_more: false }]],
      ]),
      // `due` is simply absent. This is the shape that used to be read as a tidy
      // zero (`Number(parsed.due ?? 0)`), which reported a swept backlog for a
      // count the globe never sent - so an absent count has to be its own
      // failure, and the message has to name which one is missing.
      [{ body: { success: true, locked: 4, unapplied: 0, failed: 0, hasMore: false } }],
    )
    vi.stubGlobal('fetch', stub.impl)

    await expect(main()).rejects.toThrow(/reported due as null instead of a number/)
    expect(stub.sweepCalls).toHaveLength(1)
  })

  it('fails specifically when the globe URL is missing', async () => {
    pool.query.mockImplementation(routeQuery({ ledger: [ledgerRow()] }))
    process.env.CROSS_SERVICE_SECRET = CROSS_SERVICE_SECRET_VALUE
    delete process.env.WWV_GLOBE_URL
    const stub = combinedStub(
      new Map([
        ['/v1/customers', [{ data: [customer('cus_1', 'subscriber@example.com')], has_more: false }]],
        ['/v1/subscriptions', [{ data: [], has_more: false }]],
      ]),
      [{ body: { success: true, due: 0, locked: 0, unapplied: 0, failed: 0, hasMore: false } }],
    )
    vi.stubGlobal('fetch', stub.impl)

    await expect(main()).rejects.toThrow(/WWV_GLOBE_URL is not set/)
    expect(stub.sweepCalls).toHaveLength(0)
  })
})
