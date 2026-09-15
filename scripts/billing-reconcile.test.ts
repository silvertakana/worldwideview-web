import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { main } from './billing-reconcile.mjs'
import { STUCK_EVENT_THRESHOLD_MS } from './lib/billing-backlog-core.mjs'
import { MAX_SWEEP_ROUNDS, TIER_LOCK_SWEEP_PATH } from './lib/globe-tier-lock-sweep.mjs'

/**
 * Drives the runner end to end against a stubbed database and a stubbed Stripe,
 * so the parts that cannot be reasoned about from the pure cores are actually
 * executed: pagination, the exit code, the sweep phase, and the fact that a
 * queue which cannot be READ fails the run instead of reporting health.
 */

type Row = Record<string, unknown>

const db = vi.hoisted(() => ({
  ledger: [] as Array<Record<string, unknown>>,
  failures: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  /** Table whose query should throw, for the "cannot read must fail" cases. */
  failTable: '',
  queries: [] as string[],
  params: [] as unknown[][],
  endCount: 0,
}))

// The runner now issues three different statements against one pool, so the mock
// dispatches on the SQL instead of returning the same rows to all of them.
vi.mock('pg', () => ({
  Pool: class MockPool {
    async query(sql: string, params?: unknown[]) {
      db.queries.push(sql)
      if (params) db.params.push(params)
      if (db.failTable && sql.includes(db.failTable)) {
        throw new Error(`relation "public.${db.failTable}" does not exist`)
      }
      if (sql.includes('billing_subscriptions')) return { rows: db.ledger }
      if (sql.includes('billing_failures')) return { rows: db.failures }
      if (sql.includes('webhook_events')) return { rows: db.events }
      return { rows: [] }
    }
    async end() {
      db.endCount += 1
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
      body: { success: true, due: 0, locked: 0, hasMore: false },
    }
    sweepIndex += 1
    const status = reply.status ?? 200
    return { ok: status === 200, status, text: async () => JSON.stringify(reply.body) }
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
const ledgerRow = (over: Row = {}) => ({
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

/** A row of billing_failures: durable, unresolved, and previously unread. */
const failureRow = (over: Row = {}) => ({
  id: 'fail-1',
  user_id: 'user-1',
  email: 'broken@example.com',
  event_id: 'evt_1',
  event_type: 'checkout.session.completed',
  stage: 'provision',
  error: 'globe returned 500',
  attempts: 3,
  first_seen_at: new Date('2026-09-01T00:00:00.000Z'),
  last_attempt_at: new Date('2026-09-01T00:05:00.000Z'),
  resolved_at: null,
  ...over,
})

/** A webhook event claimed and never finished, last touched `hoursAgo` ago. */
const stuckEventRow = (hoursAgo = 3, over: Row = {}) => ({
  event_id: 'evt_stuck_1',
  last_attempt_at: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
  last_error: 'handler threw',
  ...over,
})

/** The Stripe side that agrees with ledgerRow(), so no drift is reported. */
const agreeingStripe = () =>
  new Map([
    ['/v1/customers', [{ data: [customer('cus_1', 'subscriber@example.com')], has_more: false }]],
    ['/v1/subscriptions', [{ data: [subscription()], has_more: false }]],
  ])

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  vi.restoreAllMocks()
  db.ledger = []
  db.failures = []
  db.events = []
  db.failTable = ''
  db.queries = []
  db.params = []
  db.endCount = 0
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

describe('billing-reconcile runner: drift detection', () => {
  it('exits 0 when the ledger and Stripe agree', async () => {
    db.ledger = [ledgerRow()]
    const stripe = stripeStub(agreeingStripe())
    vi.stubGlobal('fetch', stripe.impl)

    await expect(main()).resolves.toBe(0)
    expect(db.endCount).toBeGreaterThan(0)
  })

  it('exits 1 when the two sides disagree', async () => {
    db.ledger = [ledgerRow()]
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
    db.ledger = [ledgerRow()]
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
    delete process.env.SUPABASE_DB_URL

    await expect(main()).rejects.toThrow(/SUPABASE_DB_URL is not set/)
  })

  it('fails specifically when the Stripe credential is missing', async () => {
    delete process.env.STRIPE_SECRET_KEY

    await expect(main()).rejects.toThrow(/STRIPE_SECRET_KEY is not set/)
  })
})

describe('billing-reconcile runner: the two durable queues', () => {
  it('reads both queues on every run, including a healthy one', async () => {
    db.ledger = [ledgerRow()]
    vi.stubGlobal('fetch', stripeStub(agreeingStripe()).impl)

    await expect(main()).resolves.toBe(0)

    expect(db.queries.some((sql) => sql.includes('billing_failures'))).toBe(true)
    expect(db.queries.some((sql) => sql.includes('webhook_events'))).toBe(true)
    // Only unfinished events matter, and only those the globe has not touched.
    const eventsSql = db.queries.find((sql) => sql.includes('webhook_events')) ?? ''
    expect(eventsSql).toContain('processed_at IS NULL')
  })

  it('passes the stuck-event threshold to the query instead of hardcoding it there', async () => {
    db.ledger = [ledgerRow()]
    vi.stubGlobal('fetch', stripeStub(agreeingStripe()).impl)

    await main()

    expect(db.params.some((params) => params[0] === STUCK_EVENT_THRESHOLD_MS)).toBe(true)
  })

  it('exits 1 when a billing failure is unresolved', async () => {
    db.ledger = [ledgerRow()]
    db.failures = [failureRow()]
    vi.stubGlobal('fetch', stripeStub(agreeingStripe()).impl)

    await expect(main()).resolves.toBe(1)
  })

  it('exits 1 when a webhook event was claimed and never finished', async () => {
    db.ledger = [ledgerRow()]
    db.events = [stuckEventRow()]
    vi.stubGlobal('fetch', stripeStub(agreeingStripe()).impl)

    await expect(main()).resolves.toBe(1)
  })

  it('ignores a resolved failure and a still-recent unfinished event', async () => {
    db.ledger = [ledgerRow()]
    db.failures = [failureRow({ resolved_at: new Date('2026-09-02T00:00:00.000Z') })]
    // One minute old: Stripe is very likely still retrying this one.
    db.events = [stuckEventRow(0)]
    vi.stubGlobal('fetch', stripeStub(agreeingStripe()).impl)

    await expect(main()).resolves.toBe(0)
  })

  it('fails loudly when billing_failures cannot be read', async () => {
    db.ledger = [ledgerRow()]
    db.failTable = 'billing_failures'
    vi.stubGlobal('fetch', stripeStub(agreeingStripe()).impl)

    // Not a clean "0 failures": a queue that could not be read is not empty.
    await expect(main()).rejects.toThrow(/billing_failures/)
    await expect(main()).rejects.toThrow(/does not exist/)
  })

  it('fails loudly when webhook_events cannot be read', async () => {
    db.ledger = [ledgerRow()]
    db.failTable = 'webhook_events'
    vi.stubGlobal('fetch', stripeStub(agreeingStripe()).impl)

    await expect(main()).rejects.toThrow(/webhook_events/)
  })

  it('fails loudly when the ledger itself cannot be read', async () => {
    db.failTable = 'billing_subscriptions'
    vi.stubGlobal('fetch', stripeStub(agreeingStripe()).impl)

    await expect(main()).rejects.toThrow(/billing_subscriptions/)
  })

  it('still reports drift when the queues could not be read alongside it', async () => {
    db.ledger = [ledgerRow()]
    db.failTable = 'billing_failures'
    const stripe = stripeStub(
      new Map([
        ['/v1/customers', [{ data: [customer('cus_1', 'subscriber@example.com')], has_more: false }]],
        ['/v1/subscriptions', [{ data: [subscription({ status: 'past_due' })], has_more: false }]],
      ]),
    )
    vi.stubGlobal('fetch', stripe.impl)

    // The read failure wins: whatever the drift would have said, the run failed.
    await expect(main()).rejects.toThrow(/does not exist/)
  })
})

describe('billing-reconcile runner: the globe lock sweep', () => {
  it('fails on the missing sweep secret instead of silently skipping the lock phase', async () => {
    db.ledger = [ledgerRow()]
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
    db.ledger = [ledgerRow()]
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
    db.ledger = [ledgerRow()]
    process.env.CROSS_SERVICE_SECRET = CROSS_SERVICE_SECRET_VALUE
    const stub = combinedStub(
      new Map([
        ['/v1/customers', [{ data: [customer('cus_1', 'subscriber@example.com')], has_more: false }]],
        // Stripe holds nothing for a grant the ledger is still carrying.
        ['/v1/subscriptions', [{ data: [], has_more: false }]],
      ]),
      [{ body: { success: true, due: 1, locked: 1, hasMore: false } }],
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

  it('fails the run when the globe answers 200 with a partial sweep', async () => {
    db.ledger = [ledgerRow()]
    process.env.CROSS_SERVICE_SECRET = CROSS_SERVICE_SECRET_VALUE
    const stub = combinedStub(
      new Map([
        ['/v1/customers', [{ data: [customer('cus_1', 'subscriber@example.com')], has_more: false }]],
        ['/v1/subscriptions', [{ data: [], has_more: false }]],
      ]),
      [{ status: 200, body: { success: false, due: 4, locked: 2, unapplied: 1, failed: 1, hasMore: false } }],
    )
    vi.stubGlobal('fetch', stub.impl)

    // HTTP 200 is not an all-clear: the body says organizations were not enforced.
    await expect(main()).rejects.toThrow(/did not complete/)
  })

  it('re-asks the globe up to the round bound while it reports more work', async () => {
    db.ledger = [ledgerRow()]
    process.env.CROSS_SERVICE_SECRET = CROSS_SERVICE_SECRET_VALUE
    const stub = combinedStub(
      new Map([
        ['/v1/customers', [{ data: [customer('cus_1', 'subscriber@example.com')], has_more: false }]],
        ['/v1/subscriptions', [{ data: [], has_more: false }]],
      ]),
      [{ body: { success: true, due: 500, locked: 500, hasMore: true } }],
    )
    vi.stubGlobal('fetch', stub.impl)

    await expect(main()).rejects.toThrow(/still reports hasMore/)
    expect(stub.sweepCalls).toHaveLength(MAX_SWEEP_ROUNDS)
  })

  it('fails specifically when the globe URL is missing', async () => {
    db.ledger = [ledgerRow()]
    process.env.CROSS_SERVICE_SECRET = CROSS_SERVICE_SECRET_VALUE
    delete process.env.WWV_GLOBE_URL
    const stub = combinedStub(
      new Map([
        ['/v1/customers', [{ data: [customer('cus_1', 'subscriber@example.com')], has_more: false }]],
        ['/v1/subscriptions', [{ data: [], has_more: false }]],
      ]),
      [{ body: { success: true, due: 0, locked: 0, hasMore: false } }],
    )
    vi.stubGlobal('fetch', stub.impl)

    await expect(main()).rejects.toThrow(/WWV_GLOBE_URL is not set/)
    expect(stub.sweepCalls).toHaveLength(0)
  })
})
