import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Call = { table: string; op: string; args: unknown[] }
  const calls: Call[] = []
  const state = {
    calls,
    user: { id: 'user_1' } as unknown,
    hasTier: false,
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
  h.state.user = { id: 'user_1' }
  h.state.hasTier = false
  h.state.script = () => ({ data: null, error: null })
})

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
