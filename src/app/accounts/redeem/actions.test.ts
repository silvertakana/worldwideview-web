import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Call = { table: string; op: string; args: unknown[] }
  const calls: Call[] = []
  const state = {
    calls,
    user: { id: 'user_1', email: 'buyer@example.com' } as unknown,
    hasTier: false,
    // What resolveEffectiveHubTier() answers. Defaults to "pro" so the legacy
    // beta_tester fixture code exercises the FLOOR rule (pro outranks beta_tester,
    // so pro is pushed) rather than the globe-tier guard.
    resolution: { tier: 'pro', source: 'stripe' } as { tier: string; source: string },
    // The globe's side of the second write, and what the action recorded about it.
    pushes: [] as { email: string; tier: string }[],
    pushResult: {
      ok: true,
      detail: 'The globe now grants "pro" for buyer@example.com.',
    } as Record<string, unknown>,
    failures: [] as Record<string, unknown>[],
    alerts: [] as unknown[][],
    // Scripted per-query response. The builder collects its own chain operations
    // so a test can answer the SELECT and the UPDATE of the same table
    // differently, which is what the race cases need.
    script: (_table: string, _ops: Call[]): { data: unknown; error: unknown } => ({
      data: null,
      error: null,
    }),
  }

  const makeBuilder = (table: string) => {
    const ops: Call[] = []
    const builder: Record<string, unknown> = {}
    const record = (op: string, args: unknown[]) => {
      const call = { table, op, args }
      ops.push(call)
      calls.push(call)
      return builder
    }
    for (const op of ['select', 'eq', 'ilike', 'is', 'lt', 'gt', 'update', 'insert', 'delete']) {
      builder[op] = (...args: unknown[]) => record(op, args)
    }
    builder.single = () => record('single', [])
    // Awaiting the builder at any point in the chain resolves the scripted rows.
    builder.then = (resolve: (value: unknown) => unknown) => resolve(state.script(table, ops))
    return builder
  }

  return { state, makeBuilder }
})

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.state.user } }) },
  }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: (table: string) => h.makeBuilder(table) }),
}))

vi.mock('@/lib/auth/entitlements', () => ({ hasTier: async () => h.state.hasTier }))

// The REAL tier-rank table is kept (the floor rule is exactly what is under
// test); only the resolution is stubbed. The real function reads Stripe, and a
// unit test must not reach the network.
vi.mock('@/lib/billing/tier-rank', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/billing/tier-rank')>()
  return { ...actual, resolveEffectiveHubTier: async () => h.state.resolution }
})

// The second write. Stubbed at the module boundary so a globe that failed can be
// scripted without an HTTP server, and so a successful push can be asserted on.
vi.mock('@/lib/billing/globe-sync', () => ({
  pushTierToGlobe: async (input: { email: string; tier: string }) => {
    h.state.pushes.push(input)
    return h.state.pushResult
  },
}))

// The operator's queue and the alert channel: the action's OWN contribution is
// what is asserted here. records.ts and alerts/notify.ts have their own tests.
vi.mock('@/lib/billing/records', () => ({
  recordFailure: async (input: Record<string, unknown>) => {
    h.state.failures.push(input)
    return true
  },
}))

vi.mock('@/lib/alerts/notify', () => ({
  notify: async (...args: unknown[]) => {
    h.state.alerts.push(args)
  },
}))

import { redeemCode } from './actions'

const WELL_FORMED = 'WWV-ABCDE-FGHJK'

const ACCESS_CODE = {
  id: 'code_1',
  code: WELL_FORMED,
  tier: 'beta_tester',
  grants_days: 30,
  use_count: 0,
  max_uses: 1,
  revoked_at: null,
  expires_at: null,
}

function callsTo(table: string) {
  return h.state.calls.filter((call) => call.table === table)
}

function opsOf(table: string, op: string) {
  return callsTo(table).filter((call) => call.op === op)
}

beforeEach(() => {
  h.state.calls.length = 0
  h.state.user = { id: 'user_1', email: 'buyer@example.com' }
  h.state.hasTier = false
  h.state.resolution = { tier: 'pro', source: 'stripe' }
  h.state.pushes.length = 0
  h.state.pushResult = { ok: true, detail: 'The globe now grants "pro" for buyer@example.com.' }
  h.state.failures.length = 0
  h.state.alerts.length = 0
  h.state.script = () => ({ data: null, error: null })
})

/** The script every successful redemption needs: a code that consumes cleanly. */
function consumableCode() {
  h.state.script = (table, ops) => {
    if (table === 'access_codes' && ops.some((op) => op.op === 'update')) {
      return { data: [{ ...ACCESS_CODE, use_count: 1 }], error: null }
    }
    if (table === 'access_codes') return { data: ACCESS_CODE, error: null }
    return { data: null, error: null }
  }
}

describe('redeemCode input validation', () => {
  it.each([
    ['an ILIKE percent wildcard', 'WWV-ABCDE-FGH%K'],
    ['an ILIKE underscore wildcard', 'WWV-A____-_____'],
    ['a bare wildcard pattern', 'A%'],
    ['a backslash escape character', 'WWV-ABC\\E-FGHJK'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['an over-long string', `WWV-ABCDE-FGHJK${'X'.repeat(64)}`],
    ['a truncated code', 'WWV-ABCDE'],
    ['a code with a SQL fragment', "WWV-ABC'--FGHJK"],
  ])('rejects %s without issuing any database query', async (_label, input) => {
    const result = await redeemCode(input)

    expect(result).toHaveProperty('error')
    // The whole point: the database is never reached, so no value can ever be
    // interpreted as a pattern.
    expect(h.state.calls).toHaveLength(0)
  })
})

describe('redeemCode lookup shape', () => {
  it('looks a well-formed code up with an exact match, never a pattern', async () => {
    h.state.script = (table, ops) => {
      if (table === 'access_codes' && ops.some((op) => op.op === 'update')) {
        return { data: [{ ...ACCESS_CODE, use_count: 1 }], error: null }
      }
      if (table === 'access_codes') return { data: ACCESS_CODE, error: null }
      return { data: null, error: null }
    }

    const result = await redeemCode(WELL_FORMED)

    expect(result).toEqual({ success: true, tier: 'beta_tester' })
    expect(opsOf('access_codes', 'eq').some((c) => c.args[0] === 'code' && c.args[1] === WELL_FORMED)).toBe(true)
    expect(opsOf('access_codes', 'ilike')).toHaveLength(0)
  })

  it('normalises a lowercase code to uppercase before querying', async () => {
    h.state.script = (table) => (table === 'access_codes' ? { data: ACCESS_CODE, error: null } : { data: null, error: null })

    await redeemCode(WELL_FORMED.toLowerCase())

    const codeEq = opsOf('access_codes', 'eq').find((call) => call.args[0] === 'code')
    expect(codeEq?.args[1]).toBe(WELL_FORMED)
  })
})

describe('redeemCode atomicity', () => {
  it('consumes the code before granting, and never grants when the consume loses', async () => {
    h.state.script = (table, ops) => {
      if (table === 'access_codes' && ops.some((op) => op.op === 'update')) {
        return { data: [], error: null }
      }
      if (table === 'access_codes') return { data: ACCESS_CODE, error: null }
      return { data: null, error: null }
    }

    const result = await redeemCode(WELL_FORMED)

    expect(result).toHaveProperty('error')
    // The loser of the race must not insert an entitlement it cannot keep.
    expect(opsOf('user_entitlements', 'insert')).toHaveLength(0)
  })

  it('orders the consume before the grant', async () => {
    h.state.script = (table, ops) => {
      if (table === 'access_codes' && ops.some((op) => op.op === 'update')) {
        return { data: [{ ...ACCESS_CODE, use_count: 1 }], error: null }
      }
      if (table === 'access_codes') return { data: ACCESS_CODE, error: null }
      return { data: null, error: null }
    }

    await redeemCode(WELL_FORMED)

    const order = h.state.calls
      .filter((call) => call.op === 'update' || call.op === 'insert')
      .map((call) => `${call.table}.${call.op}`)
    expect(order).toEqual(['access_codes.update', 'user_entitlements.insert'])
  })

  it('returns the consumed use when the grant fails, guarded on the value it wrote', async () => {
    h.state.script = (table, ops) => {
      if (table === 'access_codes' && ops.some((op) => op.op === 'update')) {
        return { data: [{ ...ACCESS_CODE, use_count: 1 }], error: null }
      }
      if (table === 'access_codes') return { data: ACCESS_CODE, error: null }
      if (table === 'user_entitlements') {
        return { data: null, error: { message: 'duplicate key', code: '23505' } }
      }
      return { data: null, error: null }
    }

    const result = await redeemCode(WELL_FORMED)

    expect(result).toHaveProperty('error')
    const updates = opsOf('access_codes', 'update')
    expect(updates).toHaveLength(2)
    // Second update hands the use back: 1 consumed -> 0.
    expect(updates[1].args[0]).toEqual({ use_count: 0 })
    // And it is guarded on the value just written, so a concurrent redemption is
    // not clobbered.
    expect(
      h.state.calls.some(
        (call) => call.table === 'access_codes' && call.op === 'eq' && call.args[0] === 'use_count' && call.args[1] === 1,
      ),
    ).toBe(true)
  })
})

// ── the second write ────────────────────────────────────────────────
//
// Access lives on the globe, and the entitlement row is only the hub's record of
// the decision. Before this, redeemCode wrote the row and never told the globe,
// so a redeemed code granted nothing: the customer held a tier no service was
// enforcing. These tests pin both halves of the two-write grant - the push that
// must happen, and the durable failure plus alert that must happen when it does
// not.
describe('redeemCode globe sync', () => {
  it('tells the globe the resolved tier once the entitlement is recorded', async () => {
    consumableCode()

    const result = await redeemCode(WELL_FORMED)

    expect(result).toEqual({ success: true, tier: 'beta_tester' })
    expect(h.state.pushes).toEqual([{ email: 'buyer@example.com', tier: 'pro' }])
    expect(h.state.failures).toHaveLength(0)
    expect(h.state.alerts).toHaveLength(0)
  })

  it('never downgrades a customer who already holds a higher tier', async () => {
    consumableCode()
    h.state.resolution = { tier: 'team', source: 'stripe' }

    await redeemCode(WELL_FORMED)

    // Redeeming a Pro code must not take Team access away as a side effect.
    expect(h.state.pushes).toEqual([{ email: 'buyer@example.com', tier: 'team' }])
  })

  it('records a durable failure and raises a critical alert when the push fails', async () => {
    consumableCode()
    h.state.pushResult = { ok: false, failure: 'unreachable', detail: 'the globe could not be reached' }

    const result = await redeemCode(WELL_FORMED)

    // Partial failure, shaped like grantManualOverride's: the hub half landed, so
    // the customer must NOT be told to try again.
    expect(result).toMatchObject({ granted: true, stage: 'globe' })
    expect(result).toHaveProperty('error')
    expect(h.state.failures).toHaveLength(1)
    // One open row per customer, so a retry counts up on billing_failures
    // (attempts) instead of filling the operator queue with duplicates.
    expect(h.state.failures[0]).toMatchObject({
      userId: 'user_1',
      eventId: 'redeem:user_1',
      eventType: 'redeem_code',
      stage: 'tier_sync',
      error: 'the globe could not be reached',
    })

    expect(h.state.alerts).toHaveLength(1)
    expect(h.state.alerts[0][0]).toBe('critical')
  })

  it('never lets the customer email ride out on the alert', async () => {
    consumableCode()
    h.state.pushResult = { ok: false, failure: 'rejected', detail: 'the globe rejected the request' }

    await redeemCode(WELL_FORMED)

    // notify() redacts every email by design and by test, so an alert that relied
    // on one would reach the founder as "[redacted]". The hub user id is the
    // handle that actually works.
    expect(JSON.stringify(h.state.alerts[0])).not.toContain('buyer@example.com')
    expect(h.state.alerts[0][3]).toMatchObject({ userId: 'user_1', eventId: 'redeem:user_1' })
  })

  it('files the failure when the account has no email to file the tier under', async () => {
    consumableCode()
    h.state.user = { id: 'user_1', email: null }

    const result = await redeemCode(WELL_FORMED)

    expect(result).toMatchObject({ granted: true, stage: 'globe' })
    expect(h.state.pushes).toHaveLength(0)
    expect(h.state.failures).toHaveLength(1)
    expect(h.state.alerts).toHaveLength(1)
  })

  it('records and alerts instead of doing nothing when the resolved tier is one the globe cannot express', async () => {
    consumableCode()
    // Nothing above the legacy code's own tier, so the floor settles on
    // beta_tester - a tier the globe's tier-sync does not accept. A silent
    // no-op here is the dead grant the code-tier restriction exists to stop.
    h.state.resolution = { tier: 'free', source: 'none' }

    const result = await redeemCode(WELL_FORMED)

    expect(result).toMatchObject({ granted: true, stage: 'globe' })
    expect(h.state.pushes).toHaveLength(0)
    expect(h.state.failures).toHaveLength(1)
    expect(h.state.failures[0]).toMatchObject({ stage: 'tier_sync' })
    expect(h.state.alerts[0][0]).toBe('critical')
  })

  it('never tells the globe when the entitlement did not land', async () => {
    h.state.script = (table, ops) => {
      if (table === 'access_codes' && ops.some((op) => op.op === 'update')) {
        return { data: [{ ...ACCESS_CODE, use_count: 1 }], error: null }
      }
      if (table === 'access_codes') return { data: ACCESS_CODE, error: null }
      if (table === 'user_entitlements') {
        return { data: null, error: { message: 'duplicate key', code: '23505' } }
      }
      return { data: null, error: null }
    }

    await redeemCode(WELL_FORMED)

    // The globe is told AFTER the hub records the decision. Granting access for
    // an entitlement that was rolled back would be strictly worse than the bug
    // this whole change fixes.
    expect(h.state.pushes).toHaveLength(0)
    expect(h.state.failures).toHaveLength(0)
  })
})
