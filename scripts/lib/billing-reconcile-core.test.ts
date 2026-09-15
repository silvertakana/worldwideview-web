import { describe, it, expect } from 'vitest'
import { reconcile, isSweepEligible, DRIFT_CLASSES } from './billing-reconcile-core.mjs'

/**
 * The comparison core is the only part of the reconciler whose correctness
 * does not depend on Stripe or the database being reachable, so it carries the
 * whole test burden. Every drift class below is exercised against real
 * fixtures.
 */

type Row = {
  user_id?: string | null
  email?: string
  stripe_customer_id?: string | null
  stripe_subscription_id?: string | null
  price_id?: string | null
  plan?: string | null
  interval?: string | null
  status?: string
  stripe_status?: string | null
  current_period_end?: string | null
  source?: 'stripe' | 'manual'
}

type Sub = {
  subscriptionId: string
  customerId: string | null
  email?: string | null
  status: string
  priceId?: string | null
  interval?: string | null
  currentPeriodEnd?: string | null
}

const PERIOD_END = '2026-10-01T00:00:00.000Z'

const row = (over: Partial<Row> = {}): Row => ({
  user_id: 'user-1',
  email: 'subscriber@example.com',
  stripe_customer_id: 'cus_1',
  stripe_subscription_id: 'sub_1',
  price_id: 'price_pro_month',
  plan: 'pro',
  interval: 'month',
  status: 'active',
  stripe_status: 'active',
  current_period_end: PERIOD_END,
  source: 'stripe',
  ...over,
})

const sub = (over: Partial<Sub> = {}): Sub => ({
  subscriptionId: 'sub_1',
  customerId: 'cus_1',
  email: 'subscriber@example.com',
  status: 'active',
  priceId: 'price_pro_month',
  interval: 'month',
  currentPeriodEnd: PERIOD_END,
  ...over,
})

const run = (ledger: Row[], stripe: Sub[], now = 1_000_000) => reconcile({ ledger, stripe, now })

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

describe('reconcile', () => {
  it('reports no drift when the two sides agree', () => {
    const report = run([row()], [sub()])
    expect(report.ok).toBe(true)
    expect(report.drift).toEqual([])
    expect(report.counts.total).toBe(0)
  })

  it('flags a live Stripe subscription the ledger never recorded, as Stripe-authoritative', () => {
    const report = run([], [sub()])
    expect(report.drift).toHaveLength(1)
    const [item] = report.drift
    expect(item.driftClass).toBe('missing_from_ledger')
    // Stripe proves they paid; the missing thing is our own grant record.
    expect(item.authority).toBe('stripe')
    expect(item.subscriptionId).toBe('sub_1')
    expect(item.email).toBe('subscriber@example.com')
    expect(item.ledgerValue).toBeNull()
  })

  it('flags a ledger grant Stripe no longer backs, as ledger-authoritative', () => {
    const report = run([row()], [])
    expect(report.drift).toHaveLength(1)
    const [item] = report.drift
    expect(item.driftClass).toBe('missing_from_stripe')
    // Whether the grant survives is this hub's decision, so the ledger owns it.
    expect(item.authority).toBe('ledger')
    expect(item.ledgerValue).toBe('active')
    expect(item.stripeValue).toBeNull()
  })

  it('classifies a status disagreement in the hub vocabulary, against Stripe', () => {
    const report = run([row({ status: 'active' })], [sub({ status: 'past_due' })])
    expect(report.drift).toHaveLength(1)
    const [item] = report.drift
    expect(item.driftClass).toBe('status_mismatch')
    expect(item.authority).toBe('stripe')
    expect(item.field).toBe('status')
    expect(item.ledgerValue).toBe('active')
    // The mapped hub status, not the raw Stripe one, is what the report compares.
    expect(item.stripeValue).toBe('past_due')
  })

  it('maps unpaid to suspended rather than treating it as its own state', () => {
    const report = run([row({ status: 'suspended' })], [sub({ status: 'unpaid' })])
    expect(report.drift).toEqual([])
  })

  it('treats a trialing subscription as agreement, not as drift', () => {
    const report = run(
      [row({ status: 'trialing' })],
      [sub({ status: 'trialing' })],
    )
    expect(report.drift).toEqual([])
  })

  it('flags a price disagreement', () => {
    const report = run([row()], [sub({ priceId: 'price_team_month' })])
    expect(report.drift).toHaveLength(1)
    const [item] = report.drift
    expect(item.driftClass).toBe('plan_mismatch')
    expect(item.authority).toBe('stripe')
    expect(item.field).toBe('price_id')
    expect(item.ledgerValue).toBe('price_pro_month')
    expect(item.stripeValue).toBe('price_team_month')
  })

  it('flags an interval disagreement', () => {
    const report = run([row()], [sub({ interval: 'year' })])
    expect(report.drift).toHaveLength(1)
    const [item] = report.drift
    expect(item.driftClass).toBe('plan_mismatch')
    expect(item.field).toBe('interval')
  })

  it('flags a period-end disagreement', () => {
    const report = run(
      [row()],
      [sub({ currentPeriodEnd: '2026-11-01T00:00:00.000Z' })],
    )
    expect(report.drift).toHaveLength(1)
    const [item] = report.drift
    expect(item.driftClass).toBe('current_period_end_mismatch')
    expect(item.authority).toBe('stripe')
  })

  it('compares period ends as instants, so equivalent timestamps are not drift', () => {
    const report = run(
      [row({ current_period_end: '2026-10-01T00:00:00Z' })],
      [sub({ currentPeriodEnd: '2026-10-01T00:00:00.000Z' })],
    )
    expect(report.drift).toEqual([])
  })

  it('flags a period end the ledger never recorded', () => {
    const report = run([row({ current_period_end: null })], [sub()])
    expect(report.drift).toHaveLength(1)
    expect(report.drift[0].driftClass).toBe('current_period_end_mismatch')
  })

  it('never treats an unrecognised Stripe status as agreement', () => {
    const report = run([row()], [sub({ status: 'renegotiating' })])
    expect(report.drift).toHaveLength(1)
    const [item] = report.drift
    expect(item.driftClass).toBe('unknown_stripe_status')
    expect(item.authority).toBe('stripe')
    expect(item.stripeValue).toBe('renegotiating')
  })

  it('matches on customer id when the ledger has no subscription id', () => {
    const report = run(
      [row({ stripe_subscription_id: null })],
      [sub({ subscriptionId: 'sub_other' })],
    )
    expect(report.drift).toEqual([])
  })

  it('does not report a finished Stripe subscription as an unrecorded grant', () => {
    const report = run([], [sub({ status: 'canceled' }), sub({ status: 'incomplete_expired' })])
    expect(report.drift).toEqual([])
  })

  it('reports operator-owned rows separately and never as drift', () => {
    const report = run(
      [row({ source: 'manual', status: 'active' })],
      [sub({ status: 'canceled' })],
    )
    expect(report.drift).toEqual([])
    expect(report.counts.operatorOwned).toBe(1)
    expect(report.operatorOwned).toHaveLength(1)
    expect(report.operatorOwned[0].reason).toBe(
      'source=manual: operator-owned, not reconciled',
    )
    expect(report.operatorOwned[0].activeInStripe).toBe(false)
  })

  it('does not report the Stripe subscription of a manual row as unrecorded', () => {
    const report = run([row({ source: 'manual' })], [sub()])
    expect(report.drift).toEqual([])
    expect(report.operatorOwned[0].linkedStripeSubscriptionId).toBe('sub_1')
  })

  it('ignores price and period disagreement on operator-owned rows', () => {
    const report = run(
      [row({ source: 'manual', price_id: 'price_operator', current_period_end: null })],
      [sub()],
    )
    expect(report.drift).toEqual([])
  })

  it('counts every drift class, including the ones that found nothing', () => {
    const report = run([row()], [])
    expect(Object.keys(report.counts).sort()).toEqual(
      [...DRIFT_CLASSES, 'operatorOwned', 'total'].sort(),
    )
    expect(report.counts.missing_from_stripe).toBe(1)
    expect(report.counts.plan_mismatch).toBe(0)
  })

  it('stamps the injected clock instead of reading the system clock', () => {
    const report = run([], [], 1_700_000_000_000)
    expect(report.evaluatedAt).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it('is deterministic and leaves its inputs untouched', () => {
    const ledger = deepFreeze([row({ status: 'past_due' }), row({ source: 'manual', email: 'owner@example.com' })])
    const stripe = deepFreeze([sub({ status: 'active' })])
    const first = reconcile({ ledger, stripe, now: 42 })
    const second = reconcile({ ledger, stripe, now: 42 })
    expect(first).toEqual(second)
    expect(ledger).toHaveLength(2)
    expect(stripe).toHaveLength(1)
  })

  it('orders drift deterministically by class then identity', () => {
    const report = run(
      [
        row({ email: 'b@example.com', stripe_subscription_id: 'sub_b', stripe_customer_id: 'cus_b' }),
        row({ email: 'a@example.com', stripe_subscription_id: 'sub_a', stripe_customer_id: 'cus_a' }),
      ],
      [],
    )
    expect(report.drift.map((item) => item.email)).toEqual([
      'a@example.com',
      'b@example.com',
    ])
  })
})

describe('isSweepEligible', () => {
  const eligible = (ledger: Row[], stripe: Sub[]) => run(ledger, stripe).drift.filter(isSweepEligible)

  it('accepts a grant Stripe no longer backs', () => {
    expect(eligible([row()], [])).toHaveLength(1)
  })

  it('accepts a status that has lapsed', () => {
    expect(eligible([row({ status: 'active' })], [sub({ status: 'canceled' })])).toHaveLength(1)
    expect(eligible([row({ status: 'active' })], [sub({ status: 'unpaid' })])).toHaveLength(1)
  })

  it('rejects differences that are not about payment having stopped', () => {
    expect(eligible([row()], [sub({ priceId: 'price_team_month' })])).toHaveLength(0)
    expect(eligible([row()], [sub({ status: 'past_due' })])).toHaveLength(0)
    expect(eligible([], [sub()])).toHaveLength(0)
  })
})
