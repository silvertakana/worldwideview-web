import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { signCrossServiceRequest as signReference } from '../../src/lib/cross-service/sign'
import {
  GLOBE_URL_VAR,
  MAX_SWEEP_ROUNDS,
  TIER_LOCK_SWEEP_PATH,
  describeSweepCounts,
  requireCrossServiceSecret,
  requireGlobeUrl,
  signCrossServiceRequest,
  requestTierLockSweep,
} from './globe-tier-lock-sweep.mjs'

/**
 * The lock sweep is the one part of the reconciler that is not a read, so its
 * guarantees are pinned here rather than reasoned about:
 *
 *   1. It refuses to run without its secret or without the globe's address, and
 *      refuses BEFORE any network call.
 *   2. Its signature is byte-identical to the hub's own signer, which is the
 *      only thing standing between a scheduled run and a 401 at 6am.
 *   3. It sends no payload. The account emails exist for the log line only.
 *   4. It reads the globe's four counts and refuses to turn an absent one into a
 *      zero, because "the globe did not say" and "the globe said zero" are the
 *      same thing to a log reader and opposite things to an operator. That is
 *      why the older two-count reply appears here as a REFUSAL: the shape this
 *      runner once accepted is now the shape that fails the run, and the counts
 *      are read in the order due, locked, unapplied, failed so a body missing
 *      one is refused by its own name.
 *   5. A body it cannot read is not a passing sweep either, so an empty or
 *      whitespace-only body, a body that is not JSON, and valid JSON that is not
 *      an object (a string, a number, null, a boolean, an array) are all
 *      refused, and each refusal says which of those it got.
 *   6. It judges the sweep by the BODY, never the HTTP status: a partial sweep
 *      is a 200, and treating that as healthy would be a false all-clear.
 */

const SECRET = 'test-secret-for-hmac-vitest-2026'
const GLOBE = 'https://globe.test'
/** Fixed so signatures are comparable; the cannonical string signs seconds. */
const FIXED_TIMESTAMP = 1234567890

const ORIGINAL_SECRET = process.env.CROSS_SERVICE_SECRET
const ORIGINAL_URL = process.env.WWV_GLOBE_URL

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CROSS_SERVICE_SECRET
  else process.env.CROSS_SERVICE_SECRET = ORIGINAL_SECRET
  if (ORIGINAL_URL === undefined) delete process.env.WWV_GLOBE_URL
  else process.env.WWV_GLOBE_URL = ORIGINAL_URL
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Pulls the sig= component out of a signature header. */
function sigOf(header: string): string {
  const match = header.match(/sig=([0-9a-f]+)/)
  if (!match) throw new Error(`no sig= component in ${header}`)
  return match[1]
}

/**
 * Runs a promise that must reject and hands back what it threw. Typed, and it
 * fails the test if the call unexpectedly succeeds instead of quietly returning
 * undefined.
 */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (thrown) {
    return thrown as Error
  }
  throw new Error('expected this call to reject, but it resolved')
}

/**
 * The reply the real route sends for a sweep that found nothing to do: all four
 * counts present, because a body without them is now rejected on purpose.
 */
const EMPTY_SWEEP = { success: true, due: 0, locked: 0, unapplied: 0, failed: 0, hasMore: false }

// `raw` serves a literally unreadable response body, which JSON.stringify
// cannot express (a string body would serialize as valid JSON).
type SweepReply = { status?: number; body?: unknown; raw?: string }

/** Serves a queued reply per call and records the exact request. */
function sweepStub(replies: SweepReply[]) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = []
  let index = 0
  const impl = async (
    input: string | URL,
    init?: { method?: string; headers?: Record<string, string>; body?: unknown },
  ) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body,
    })
    const reply = replies[index] ?? replies[replies.length - 1] ?? { body: EMPTY_SWEEP }
    index += 1
    const status = reply.status ?? 200
    return {
      ok: status === 200,
      status,
      text: async () => (reply.raw !== undefined ? reply.raw : JSON.stringify(reply.body)),
    }
  }
  return { impl, calls }
}

/** Every line the run logged, joined the way a reader sees it. */
function loggedLines(): string[] {
  return vi.mocked(console.log).mock.calls.map((args) => args.map((part) => String(part)).join(' '))
}

describe('requireCrossServiceSecret', () => {
  it('names the missing variable when it is absent', () => {
    delete process.env.CROSS_SERVICE_SECRET
    expect(() => requireCrossServiceSecret()).toThrow(/CROSS_SERVICE_SECRET is not set/)
  })

  it('says that adding it is a human step', () => {
    delete process.env.CROSS_SERVICE_SECRET
    expect(() => requireCrossServiceSecret()).toThrow(/human step/)
  })

  it('returns the secret when it is present', () => {
    process.env.CROSS_SERVICE_SECRET = 'test-secret'
    expect(requireCrossServiceSecret()).toBe('test-secret')
  })
})

describe('requireGlobeUrl', () => {
  it('names the missing variable when it is absent', () => {
    delete process.env.WWV_GLOBE_URL
    expect(() => requireGlobeUrl()).toThrow(/WWV_GLOBE_URL is not set/)
  })

  it('says it will not read PROVISIONING_API_URL or guess a default', () => {
    delete process.env.WWV_GLOBE_URL
    expect(() => requireGlobeUrl()).toThrow(/does not read it and does not guess a default/)
  })

  it('returns the configured base URL with no trailing slash', () => {
    process.env.WWV_GLOBE_URL = 'https://globe.test/'
    expect(requireGlobeUrl()).toBe('https://globe.test')
  })

  it('is documented under the name the workflow sets', () => {
    expect(GLOBE_URL_VAR).toBe('WWV_GLOBE_URL')
  })
})

describe('signCrossServiceRequest', () => {
  // The hub signer reads the secret from the environment rather than taking it
  // as an argument, so the differential cases below need it set.
  beforeEach(() => {
    process.env.CROSS_SERVICE_SECRET = SECRET
  })

  it.each([
    ['an empty body', { method: 'POST', path: TIER_LOCK_SWEEP_PATH }],
    ['a JSON body', { method: 'POST', path: '/api/test', body: { key: 'value' } }],
    ['a path carrying a query string', { method: 'POST', path: '/api/test?a=1', body: { key: 'value' } }],
  ])('produces the same signature as the hub signer for %s', (_name, opts) => {
    const mine = signCrossServiceRequest({ ...opts, timestamp: FIXED_TIMESTAMP, secret: SECRET })
    const theirs = signReference({ ...opts, timestamp: FIXED_TIMESTAMP })

    expect(sigOf(mine['X-Service-Signature'])).toBe(sigOf(theirs['X-Service-Signature']))
    expect(mine['X-Service-Timestamp']).toBe(theirs['X-Service-Timestamp'])
  })

  it('reproduces the vector pinned by src/lib/cross-service/sign.test.ts', () => {
    // Copied from that file's "produces same HMAC as globe-side sign" test.
    const headers = signCrossServiceRequest({
      method: 'POST',
      path: '/api/test',
      body: { key: 'value' },
      timestamp: FIXED_TIMESTAMP,
      secret: SECRET,
    })
    expect(sigOf(headers['X-Service-Signature'])).toBe(
      'ed04b8ed50e9b2a95e532434456b319ec6c63cf82660ed363043aea6a57ae33b',
    )
  })

  it('signs sha256("") for the bodiless request this sweep actually sends', () => {
    // The pinned digest below is an independent HMAC over the literal canonical
    // string, with the empty-body hash spelled out. If the canonical shape ever
    // drifts, this test fails with a number instead of a 401 in production.
    const emptyBodyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    const headers = signCrossServiceRequest({
      method: 'POST',
      path: TIER_LOCK_SWEEP_PATH,
      timestamp: FIXED_TIMESTAMP,
      secret: SECRET,
    })
    expect(sigOf(headers['X-Service-Signature'])).toBe(
      '630c4046fe69c7ee7c49b54a0603429f98523ba8bbe9c819bd00083d681053a5',
    )
    expect(
      `POST\n${TIER_LOCK_SWEEP_PATH}\n${FIXED_TIMESTAMP}\n${emptyBodyHash}`,
    ).toBe('POST\n/api/service/tier-lock-sweep\n1234567890\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('normalizes a millisecond timestamp to seconds, as the globe requires', () => {
    const seconds = signCrossServiceRequest({
      method: 'POST',
      path: '/api/test',
      body: { key: 'value' },
      timestamp: FIXED_TIMESTAMP,
      secret: SECRET,
    })
    const millis = signCrossServiceRequest({
      method: 'POST',
      path: '/api/test',
      body: { key: 'value' },
      timestamp: FIXED_TIMESTAMP * 1000,
      secret: SECRET,
    })

    expect(millis['X-Service-Timestamp']).toBe('1234567890')
    expect(millis['X-Service-Signature']).toContain('t=1234567890,')
    expect(sigOf(millis['X-Service-Signature'])).toBe(sigOf(seconds['X-Service-Signature']))
  })

  it('emits the header shape the globe parses', () => {
    const headers = signCrossServiceRequest({
      method: 'POST',
      path: TIER_LOCK_SWEEP_PATH,
      timestamp: FIXED_TIMESTAMP,
      secret: SECRET,
    })
    expect(headers['X-Service-Signature']).toMatch(/^t=\d{10},n=[0-9a-f-]{36},sig=[0-9a-f]{64}$/)
    expect(headers['X-Service-Timestamp']).toBe('1234567890')
    expect(headers['X-Service-Nonce']).toMatch(/^[0-9a-f-]{36}$/)
  })
})

/**
 * The counts line. There are no optional fields left in it: every count is
 * required by the reader, so the line always names all four, and the second case
 * below is what keeps this helper from becoming decoration.
 */
describe('describeSweepCounts', () => {
  it('names all four counts in one stable order', () => {
    expect(describeSweepCounts({ due: 4, locked: 4, unapplied: 0, failed: 0 })).toBe(
      'due=4 locked=4 unapplied=0 failed=0',
    )
  })

  it('is what the per-round log line is built from', async () => {
    process.env.CROSS_SERVICE_SECRET = SECRET
    process.env.WWV_GLOBE_URL = GLOBE
    const stub = sweepStub([
      { body: { success: true, due: 4, locked: 4, unapplied: 0, failed: 0, hasMore: false } },
    ])
    vi.stubGlobal('fetch', stub.impl)

    await requestTierLockSweep({ emails: [] })

    expect(loggedLines()).toContain('[reconcile] sweep round 1: due=4 locked=4 unapplied=0 failed=0')
  })
})

describe('requestTierLockSweep', () => {
  it('fails on the missing secret rather than skipping the phase silently', async () => {
    process.env.WWV_GLOBE_URL = GLOBE
    delete process.env.CROSS_SERVICE_SECRET
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await expect(requestTierLockSweep({ emails: ['a@example.com'] })).rejects.toThrow(
      /CROSS_SERVICE_SECRET is not set/,
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fails on the missing globe URL rather than guessing an address', async () => {
    process.env.CROSS_SERVICE_SECRET = SECRET
    delete process.env.WWV_GLOBE_URL
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await expect(requestTierLockSweep({ emails: ['a@example.com'] })).rejects.toThrow(
      /WWV_GLOBE_URL is not set/,
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends a signed POST with an empty body when the configuration is complete', async () => {
    process.env.CROSS_SERVICE_SECRET = SECRET
    process.env.WWV_GLOBE_URL = GLOBE
    const stub = sweepStub([
      { body: { success: true, due: 2, locked: 2, unapplied: 0, failed: 0, hasMore: false } },
    ])
    vi.stubGlobal('fetch', stub.impl)

    const result = await requestTierLockSweep({ emails: ['a@example.com'] })

    expect(stub.calls).toHaveLength(1)
    const call = stub.calls[0]
    expect(call.url).toBe(`${GLOBE}${TIER_LOCK_SWEEP_PATH}`)
    expect(call.method).toBe('POST')
    expect(call.headers['Content-Type']).toBe('application/json')
    expect(call.headers['X-Service-Signature']).toMatch(/^t=\d{10},n=[0-9a-f-]{36},sig=[0-9a-f]{64}$/)
    expect(call.headers['X-Service-Timestamp']).toMatch(/^\d{10}$/)
    expect(call.headers['X-Service-Nonce']).toMatch(/^[0-9a-f-]{36}$/)
    expect(call.body).toBe('')
    expect(result).toEqual({ notDeployed: false, rounds: 1, due: 2, locked: 2, unapplied: 0, failed: 0, hasMore: false })
  })

  it('emits a signature the hub signer can reproduce for the same request', async () => {
    process.env.CROSS_SERVICE_SECRET = SECRET
    process.env.WWV_GLOBE_URL = GLOBE
    const stub = sweepStub([{ body: EMPTY_SWEEP }])
    vi.stubGlobal('fetch', stub.impl)

    await requestTierLockSweep({ emails: [] })

    const sent = stub.calls[0].headers
    const timestamp = Number(sent['X-Service-Timestamp'])
    // The nonce is random and is not part of the canonical string, so the
    // reference signer must produce the identical signature for this timestamp.
    const reference = signReference({ method: 'POST', path: TIER_LOCK_SWEEP_PATH, timestamp })
    expect(sigOf(sent['X-Service-Signature'])).toBe(sigOf(reference['X-Service-Signature']))
  })

  it('never puts the account emails in the request', async () => {
    process.env.CROSS_SERVICE_SECRET = SECRET
    process.env.WWV_GLOBE_URL = GLOBE
    const stub = sweepStub([
      { body: { success: true, due: 1, locked: 1, unapplied: 0, failed: 0, hasMore: false } },
    ])
    vi.stubGlobal('fetch', stub.impl)

    await requestTierLockSweep({ emails: ['lapsed@example.com', 'also@example.com'] })

    const call = stub.calls[0]
    expect(call.body).toBe('')
    expect(call.url).not.toContain('@')
    // The whole request, headers included, must be free of them.
    expect(JSON.stringify(call)).not.toContain('lapsed@example.com')
    expect(JSON.stringify(call)).not.toContain('also@example.com')
  })

  it('re-asks while the globe reports more work waiting', async () => {
    process.env.CROSS_SERVICE_SECRET = SECRET
    process.env.WWV_GLOBE_URL = GLOBE
    const stub = sweepStub([
      { body: { success: true, due: 500, locked: 500, unapplied: 0, failed: 0, hasMore: true } },
      { body: { success: true, due: 3, locked: 3, unapplied: 0, failed: 0, hasMore: false } },
    ])
    vi.stubGlobal('fetch', stub.impl)

    const result = await requestTierLockSweep({ emails: [] })

    expect(stub.calls).toHaveLength(2)
    expect(result).toEqual({ notDeployed: false, rounds: 2, due: 3, locked: 3, unapplied: 0, failed: 0, hasMore: false })
  })

  it('reports loudly rather than dropping the remainder when hasMore never clears', async () => {
    process.env.CROSS_SERVICE_SECRET = SECRET
    process.env.WWV_GLOBE_URL = GLOBE
    const stub = sweepStub([
      { body: { success: true, due: 500, locked: 0, unapplied: 0, failed: 0, hasMore: true } },
    ])
    vi.stubGlobal('fetch', stub.impl)

    await expect(requestTierLockSweep({ emails: [] })).rejects.toThrow(/still reports hasMore/)
    expect(stub.calls).toHaveLength(MAX_SWEEP_ROUNDS)
  })

  it('fails the run when the globe rejects the signature', async () => {
    process.env.CROSS_SERVICE_SECRET = SECRET
    process.env.WWV_GLOBE_URL = GLOBE
    const stub = sweepStub([{ status: 401, body: { error: 'invalid signature' } }])
    vi.stubGlobal('fetch', stub.impl)

    await expect(requestTierLockSweep({ emails: [] })).rejects.toThrow(/HTTP 401/)
  })

  it('reports an undeployed endpoint loudly without failing the run', async () => {
    process.env.CROSS_SERVICE_SECRET = SECRET
    process.env.WWV_GLOBE_URL = GLOBE
    // Globe PR #511 ships this route. Before it is deployed the globe answers
    // 404, which is a deploy that is behind - not a customer who paid and got
    // nothing. It must be visible in the log and must NOT redden the schedule.
    const stub = sweepStub([{ status: 404, raw: 'Not Found' }])
    vi.stubGlobal('fetch', stub.impl)

    const result = await requestTierLockSweep({ emails: [] })

    expect(result.notDeployed).toBe(true)
    const banner = loggedLines().find((line) => line.includes('NOT DEPLOYED'))
    expect(banner).toBeDefined()
    expect(banner).toContain(TIER_LOCK_SWEEP_PATH)
    expect(banner).toContain('#511')
    // It is explicitly neither a red run nor a clean sweep.
    expect(banner).toMatch(/NOT a red run and NOT a clean sweep/)
  })

  it('never reports an undeployed endpoint as a sweep of zeroes', async () => {
    process.env.CROSS_SERVICE_SECRET = SECRET
    process.env.WWV_GLOBE_URL = GLOBE
    const stub = sweepStub([{ status: 404, raw: 'Not Found' }])
    vi.stubGlobal('fetch', stub.impl)

    const result = await requestTierLockSweep({ emails: [] })

    // `due=0 locked=0` is the exact line a healthy sweep prints, so no per-round
    // count line may be written and only one request may be attempted.
    expect(loggedLines().some((line) => line.includes('sweep round'))).toBe(false)
    expect(result.notDeployed).toBe(true)
    expect(stub.calls).toHaveLength(1)
  })

  it('still fails on a 5xx, which is a broken globe rather than a missing deploy', async () => {
    process.env.CROSS_SERVICE_SECRET = SECRET
    process.env.WWV_GLOBE_URL = GLOBE
    const stub = sweepStub([{ status: 503, raw: 'Service Unavailable' }])
    vi.stubGlobal('fetch', stub.impl)

    await expect(requestTierLockSweep({ emails: [] })).rejects.toThrow(/HTTP 503/)
  })

  it('fails the run when the globe reports success false', async () => {
    process.env.CROSS_SERVICE_SECRET = SECRET
    process.env.WWV_GLOBE_URL = GLOBE
    const stub = sweepStub([{ body: { success: false, error: 'sweep unavailable' } }])
    vi.stubGlobal('fetch', stub.impl)

    const error = await rejection(requestTierLockSweep({ emails: [] }))

    expect(error.message).toMatch(/reported failure/)
    // No counts were sent, so the message must not invent any.
    expect(error.message).not.toMatch(/failed=/)
  })

  it('fails on a partial sweep that answers HTTP 200 with success false', async () => {
    process.env.CROSS_SERVICE_SECRET = SECRET
    process.env.WWV_GLOBE_URL = GLOBE
    // The whole point: HTTP 200 and a failure count is NOT an all-clear, so the
    // status code is not the signal this runner reads.
    const stub = sweepStub([
      { status: 200, body: { success: false, due: 5, locked: 3, unapplied: 1, failed: 2, hasMore: false } },
    ])
    vi.stubGlobal('fetch', stub.impl)

    const error = await rejection(requestTierLockSweep({ emails: [] }))

    expect(error.message).toMatch(/reported failure/)
    // The refused body is echoed, so the partial counts stay visible in the log.
    expect(error.message).toContain('"failed":2')
    expect(error.message).toContain('"unapplied":1')
  })

  it('refuses to read an absent count as a clean zero', async () => {
    process.env.CROSS_SERVICE_SECRET = SECRET
    process.env.WWV_GLOBE_URL = GLOBE
    // The exact body this runner used to accept: no `unapplied`, so the old
    // `Number(parsed.unapplied ?? 0)` reported a tidy zero for a number the
    // globe never sent. The counts are read in order, so the first missing one
    // is the one named.
    const stub = sweepStub([{ body: { success: true, due: 4, locked: 4, hasMore: false } }])
    vi.stubGlobal('fetch', stub.impl)

    await expect(requestTierLockSweep({ emails: [] })).rejects.toThrow(
      /unapplied as null instead of a number/,
    )
  })

  it('refuses a count that arrived as something other than a number', async () => {
    process.env.CROSS_SERVICE_SECRET = SECRET
    process.env.WWV_GLOBE_URL = GLOBE
    // `Number("0")` is 0, so the old code read a stringified count as a healthy
    // one. A count this runner cannot trust is reported, not coerced.
    const stub = sweepStub([
      { body: { success: true, due: 4, locked: 4, unapplied: 0, failed: '0', hasMore: false } },
    ])
    vi.stubGlobal('fetch', stub.impl)

    await expect(requestTierLockSweep({ emails: [] })).rejects.toThrow(
      /failed as "0" instead of a number/,
    )
  })

  it('fails the run when the body reports deadlines it could not apply', async () => {
    process.env.CROSS_SERVICE_SECRET = SECRET
    process.env.WWV_GLOBE_URL = GLOBE
    // The globe derives its own `success` flag from `failed`, so this body is
    // what a half-done sweep used to look like from here: a flag saying fine.
    const stub = sweepStub([
      { body: { success: true, due: 4, locked: 2, unapplied: 0, failed: 2, hasMore: false } },
    ])
    vi.stubGlobal('fetch', stub.impl)

    await expect(requestTierLockSweep({ emails: [] })).rejects.toThrow(/2 of 4 due deadline/)
  })

  it('surfaces unapplied deadlines without failing the run', async () => {
    process.env.CROSS_SERVICE_SECRET = SECRET
    process.env.WWV_GLOBE_URL = GLOBE
    const stub = sweepStub([
      { body: { success: true, due: 4, locked: 3, unapplied: 1, failed: 0, hasMore: false } },
    ])
    vi.stubGlobal('fetch', stub.impl)

    const result = await requestTierLockSweep({ emails: [] })

    expect(result).toEqual({ notDeployed: false, rounds: 1, due: 4, locked: 3, unapplied: 1, failed: 0, hasMore: false })
  })
})

/**
 * What the sweep refuses to read. A body that carries no verdict is not a
 * passing sweep, and the refusals below are the whole of that contract: an empty
 * or whitespace-only body, a body that is not JSON, and valid JSON that is not
 * an object. They run through the public call rather than the parser, because a
 * response we cannot read is only interesting as a run that fails.
 */
describe('parseSweepBody refusals', () => {
  beforeEach(() => {
    process.env.CROSS_SERVICE_SECRET = SECRET
    process.env.WWV_GLOBE_URL = GLOBE
  })

  it('refuses an empty body', async () => {
    const stub = sweepStub([{ status: 200, raw: '' }])
    vi.stubGlobal('fetch', stub.impl)

    await expect(requestTierLockSweep({ emails: [] })).rejects.toThrow(/returned an empty body/)
  })

  it('refuses a whitespace-only body', async () => {
    const stub = sweepStub([{ status: 200, raw: '   \n\t  ' }])
    vi.stubGlobal('fetch', stub.impl)

    await expect(requestTierLockSweep({ emails: [] })).rejects.toThrow(/returned an empty body/)
  })

  it('refuses a body that is not JSON', async () => {
    const stub = sweepStub([{ status: 200, raw: '<html>502 Bad Gateway</html>' }])
    vi.stubGlobal('fetch', stub.impl)

    await expect(requestTierLockSweep({ emails: [] })).rejects.toThrow(/a body that is not JSON/)
  })

  it('refuses a JSON array', async () => {
    const stub = sweepStub([{ status: 200, raw: '[]' }])
    vi.stubGlobal('fetch', stub.impl)

    await expect(requestTierLockSweep({ emails: [] })).rejects.toThrow(/not an object: an array/)
  })

  it('refuses a JSON string', async () => {
    const stub = sweepStub([{ status: 200, raw: '"sweep unavailable"' }])
    vi.stubGlobal('fetch', stub.impl)

    await expect(requestTierLockSweep({ emails: [] })).rejects.toThrow(
      /not an object: "sweep unavailable"/,
    )
  })

  it('refuses a JSON number', async () => {
    const stub = sweepStub([{ status: 200, raw: '7' }])
    vi.stubGlobal('fetch', stub.impl)

    await expect(requestTierLockSweep({ emails: [] })).rejects.toThrow(/not an object: 7/)
  })

  it('refuses JSON null', async () => {
    const stub = sweepStub([{ status: 200, raw: 'null' }])
    vi.stubGlobal('fetch', stub.impl)

    await expect(requestTierLockSweep({ emails: [] })).rejects.toThrow(/not an object: null/)
  })

  it('refuses valid JSON that is a non-object', async () => {
    const stub = sweepStub([{ status: 200, raw: 'true' }])
    vi.stubGlobal('fetch', stub.impl)

    await expect(requestTierLockSweep({ emails: [] })).rejects.toThrow(/not an object: true/)
  })
})
