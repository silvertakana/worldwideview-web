import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { main } from './billing-reconcile.mjs'
import { MAX_SWEEP_ROUNDS, TIER_LOCK_SWEEP_PATH } from './lib/globe-tier-lock-sweep.mjs'

/**
 * Drives the runner end to end against a stubbed database and a stubbed Stripe,
 * so the parts that cannot be reasoned about from the pure core are actually
 * executed: pagination, the exit code, and the fact that the sweep phase fails
 * loudly instead of being skipped.
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

describe('billing-reconcile runner', () => {
  it('exits 0 when the ledger and Stripe agree', async () => {
    pool.query.mockResolvedValue({ rows: [ledgerRow()] })
    const stripe = stripeStub(
      new Map([
        ['/v1/customers', [{ data: [customer('cus_1', 'subscriber@example.com')], has_more: false }]],
        ['/v1/subscriptions', [{ data: [subscription()], has_more: false }]],
      ]),
    )
    vi.stubGlobal('fetch', stripe.impl)

    await expect(main()).resolves.toBe(0)
    expect(pool.end).toHaveBeenCalled()
  })

  it('exits 1 when the two sides disagree', async () => {
    pool.query.mockResolvedValue({ rows: [ledgerRow()] })
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
    pool.query.mockResolvedValue({ rows: [ledgerRow()] })
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
    pool.query.mockResolvedValue({ rows: [] })
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

  it('fails on the missing sweep secret instead of silently skipping the lock phase', async () => {
    pool.query.mockResolvedValue({ rows: [ledgerRow()] })
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
    pool.query.mockResolvedValue({ rows: [ledgerRow()] })
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
    pool.query.mockResolvedValue({ rows: [ledgerRow()] })
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

  it('re-asks the globe up to the round bound while it reports more work', async () => {
    pool.query.mockResolvedValue({ rows: [ledgerRow()] })
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
    pool.query.mockResolvedValue({ rows: [ledgerRow()] })
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
