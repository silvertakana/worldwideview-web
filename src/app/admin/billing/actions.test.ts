import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockRequireAdmin, mockAdminClient, mockInvalidate, mockRevalidatePath } = vi.hoisted(
  () => ({
    mockRequireAdmin: vi.fn(),
    mockAdminClient: vi.fn(),
    mockInvalidate: vi.fn(),
    mockRevalidatePath: vi.fn(),
  }),
)

vi.mock('@/lib/auth/admin', () => ({ requireAdmin: mockRequireAdmin }))
vi.mock('next/cache', () => ({ revalidatePath: mockRevalidatePath }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mockAdminClient }))
vi.mock('@/lib/billing/kill-switch', () => ({
  invalidateBillingKillSwitchCache: mockInvalidate,
}))

import { setBillingPaused } from './actions'

/* ───────────────────────── test double ─────────────────────────
 * createAdminClient() is mocked with a chainable query builder that records
 * every call, so reads and writes can be asserted apart. Reads terminate on
 * maybeSingle(), writes terminate on being awaited; the two terminals drain
 * separate queues, so a read can never consume a queued write result.
 */

interface Call {
  table: string
  op: string
  args: unknown[]
}

const calls: Call[] = []
const findQueue: unknown[] = []
const writeQueue: unknown[] = []

function respondFind(...results: unknown[]) {
  findQueue.push(...results)
}
function respondWrite(result: unknown) {
  writeQueue.push(result)
}
/** An exhausted queue reads as "no rows, no error". */
function shift(queue: unknown[]) {
  return queue.length > 0 ? queue.shift() : { data: null, error: null }
}

function makeBuilder(table: string) {
  const state = { write: false }
  const record = (op: string) => (...args: unknown[]) => {
    calls.push({ table, op, args })
    return builder
  }
  const builder: Record<string, unknown> = {
    select: record('select'),
    eq: record('eq'),
    order: record('order'),
    limit: record('limit'),
    update: (...args: unknown[]) => {
      state.write = true
      return record('update')(...args)
    },
    insert: (...args: unknown[]) => {
      state.write = true
      return record('insert')(...args)
    },
    maybeSingle: () => {
      calls.push({ table, op: 'maybeSingle', args: [] })
      return Promise.resolve(shift(findQueue))
    },
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(shift(state.write ? writeQueue : findQueue)).then(resolve, reject),
  }
  return builder as never
}

function callsFor(op: string) {
  return calls.filter((call) => call.op === op)
}

/** Queue the control-row probe: the migration seeds exactly one row. */
function respondControlRow(id = 'row-1') {
  respondFind({ data: { id }, error: null })
}

/** The seeded row is found and both writes succeed. */
function respondHappyPath() {
  respondControlRow()
  respondWrite({ data: null, error: null })
  respondWrite({ data: null, error: null })
}

const ADMIN_USER = {
  id: 'admin-1',
  email: 'admin@example.com',
  app_metadata: { role: 'admin' },
}

beforeEach(() => {
  calls.length = 0
  findQueue.length = 0
  writeQueue.length = 0
  mockRequireAdmin.mockReset()
  mockRequireAdmin.mockResolvedValue(ADMIN_USER)
  mockInvalidate.mockReset()
  mockRevalidatePath.mockReset()
  mockAdminClient.mockReset()
  mockAdminClient.mockReturnValue({ from: (table: string) => makeBuilder(table) })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('setBillingPaused', () => {
  it('refuses an empty reason and writes nothing at all', async () => {
    const result = await setBillingPaused(true, '   ')

    expect(result.success).toBe(false)
    expect(result.error).toBe('A reason is required')
    expect(callsFor('update')).toHaveLength(0)
    expect(callsFor('insert')).toHaveLength(0)
    expect(calls).toHaveLength(0)
    expect(mockInvalidate).not.toHaveBeenCalled()
  })

  it('pause: flips the control row and records a pause event', async () => {
    respondHappyPath()

    const result = await setBillingPaused(true, 'incident-42')

    expect(result).toEqual({ success: true })

    const update = callsFor('update')
    expect(update).toHaveLength(1)
    expect(update[0].table).toBe('billing_control')
    expect(update[0].args[0]).toMatchObject({
      billing_paused: true,
      reason: 'incident-42',
      paused_by: 'admin-1',
    })

    const insert = callsFor('insert')
    expect(insert).toHaveLength(1)
    expect(insert[0].table).toBe('billing_control_events')
    expect(insert[0].args[0]).toEqual({
      action: 'pause',
      reason: 'incident-42',
      actor_user_id: 'admin-1',
    })

    expect(mockInvalidate).toHaveBeenCalledTimes(1)
    expect(mockRevalidatePath).toHaveBeenCalledWith('/admin/billing')
  })

  it('resume: flips the flag back and records a resume event', async () => {
    respondHappyPath()

    const result = await setBillingPaused(false, 'incident-42 resolved')

    expect(result).toEqual({ success: true })
    expect(callsFor('update')[0].args[0]).toMatchObject({ billing_paused: false })
    expect(callsFor('insert')[0].args[0]).toMatchObject({
      action: 'resume',
      reason: 'incident-42 resolved',
      actor_user_id: 'admin-1',
    })
    expect(mockInvalidate).toHaveBeenCalledTimes(1)
  })

  it('trims the reason before it reaches the row or the trail', async () => {
    respondHappyPath()

    await setBillingPaused(true, '  spaced reason  ')

    expect(callsFor('update')[0].args[0]).toMatchObject({ reason: 'spaced reason' })
    expect(callsFor('insert')[0].args[0]).toMatchObject({ reason: 'spaced reason' })
  })

  it('reports a missing control row and writes nothing', async () => {
    // No queued find: an exhausted queue answers "no rows".
    const result = await setBillingPaused(true, 'why')

    expect(result.success).toBe(false)
    expect(result.error).toContain('No billing_control row found')
    expect(callsFor('update')).toHaveLength(0)
    expect(callsFor('insert')).toHaveLength(0)
  })

  it('reports a control-row read failure and writes nothing', async () => {
    respondFind({ data: null, error: { message: 'relation "billing_control" does not exist' } })

    const result = await setBillingPaused(true, 'why')

    expect(result.success).toBe(false)
    expect(result.error).toContain('does not exist')
    expect(callsFor('update')).toHaveLength(0)
  })

  it('reports an update failure and writes no audit row', async () => {
    respondControlRow()
    respondWrite({ data: null, error: { message: 'update exploded' } })

    const result = await setBillingPaused(true, 'why')

    expect(result.success).toBe(false)
    expect(result.error).toBe('update exploded')
    expect(callsFor('update')).toHaveLength(1)
    expect(callsFor('insert')).toHaveLength(0)
  })

  it('reports an audit failure after the flag already changed', async () => {
    respondControlRow()
    respondWrite({ data: null, error: null })
    respondWrite({ data: null, error: { message: 'insert exploded' } })

    const result = await setBillingPaused(true, 'why')

    expect(result.success).toBe(false)
    expect(result.error).toContain('insert exploded')
    // The state change landed even though the trail did not: the operator has
    // to know the trail is incomplete rather than be told nothing happened.
    expect(callsFor('update')).toHaveLength(1)
  })

  it('is unreachable without requireAdmin: no guard fallback, no writes', async () => {
    mockRequireAdmin.mockRejectedValue(new Error('NEXT_NOT_FOUND'))

    await expect(setBillingPaused(true, 'why')).rejects.toThrow()

    expect(callsFor('update')).toHaveLength(0)
    expect(callsFor('insert')).toHaveLength(0)
    expect(calls).toHaveLength(0)
    expect(mockInvalidate).not.toHaveBeenCalled()
  })
})
