import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { main, GLOBE_USAGE_PATH } from './billing-usage-report.mjs'
import { amountCentsFor, buildInvoice, formatCents, formatInvoice, parseArgs } from './lib/billing-usage-core.mjs'

/**
 * The shadow bill is a number somebody will quote before any invoice exists, and
 * the whole point of Phase 1 is that producing it changes nothing. So the two
 * things tested here are the arithmetic (which must be readable and exactly
 * right) and the absence of writes (which must be mechanical, not a promise in a
 * comment).
 */

const GLOBE_BASE = 'https://globe.test'
const SECRET = 'test-cross-service-secret'

const usageBody = (overrides: Record<string, unknown> = {}) => ({
  period: {
    start: '2026-11-01T00:00:00.000Z',
    end: '2026-12-01T00:00:00.000Z',
    label: '2026-11',
  },
  keys: [
    {
      keyId: 'key-1',
      userId: 'user-1',
      name: 'prod',
      prefix: 'wwv_aaaaaaaa',
      calls: 1500,
      tools: [
        { toolName: 'investigate_area', calls: 1200, lastCallAt: '2026-11-07T09:00:00.000Z' },
        { toolName: 'search_entities', calls: 300, lastCallAt: '2026-11-07T08:00:00.000Z' },
      ],
    },
    {
      keyId: 'key-2',
      userId: 'user-2',
      name: 'staging',
      prefix: 'wwv_bbbbbbbb',
      calls: 250,
      tools: [{ toolName: 'fly_to', calls: 250, lastCallAt: '2026-11-06T09:00:00.000Z' }],
    },
  ],
  totalCalls: 1750,
  toolTotals: [
    { toolName: 'investigate_area', calls: 1200 },
    { toolName: 'search_entities', calls: 300 },
    { toolName: 'fly_to', calls: 250 },
  ],
  ...overrides,
})

interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/** Records every request the runner makes, and answers with one usage body. */
function fetchStub(body: unknown, status = 200) {
  const calls: Recorded[] = []
  const impl = async (input: string | URL, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body,
    })
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    }
  }
  return { impl, calls }
}

function logLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => String(call[0]))
}

let logSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  process.env.CROSS_SERVICE_SECRET = SECRET
  process.env.WWV_GLOBE_URL = GLOBE_BASE
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete process.env.CROSS_SERVICE_SECRET
  delete process.env.WWV_GLOBE_URL
})

/* ─────────────────────────── the arithmetic ─────────────────────────── */

describe('the would-be invoice maths', () => {
  it('prices calls at the rate per thousand', () => {
    expect(amountCentsFor(1000, 5)).toBe(5)
    expect(amountCentsFor(1500, 5)).toBe(8) // 7.5 cents rounds to 8
    expect(amountCentsFor(0, 5)).toBe(0)
    expect(amountCentsFor(250, 5)).toBe(1) // 1.25 rounds to 1
  })

  it('sums the printed lines rather than re-deriving the total', () => {
    const invoice = buildInvoice(usageBody() as never, 5)

    expect(invoice.keys.map((key: { amountCents: number }) => key.amountCents)).toEqual([8, 1])
    expect(invoice.totalAmountCents).toBe(9)
    expect(invoice.totalCalls).toBe(1750)
  })

  it('keeps the globe\'s own ordering instead of re-sorting', () => {
    const invoice = buildInvoice(usageBody() as never, 5)
    expect(invoice.keys.map((key: { keyId: string }) => key.keyId)).toEqual(['key-1', 'key-2'])
  })

  it('prints money as two decimals without a currency symbol', () => {
    expect(formatCents(0)).toBe('0.00')
    expect(formatCents(9)).toBe('0.09')
    expect(formatCents(1500)).toBe('15.00')
    expect(formatCents(-5)).toBe('-0.05')
  })
})

describe('formatInvoice', () => {
  it('names the period, the rate and every key with its tool split', () => {
    const lines = formatInvoice(buildInvoice(usageBody() as never, 5)).join('\n')

    expect(lines).toContain('2026-11')
    expect(lines).toContain('5 cents per 1000 calls')
    expect(lines).toContain('wwv_aaaaaaaa')
    expect(lines).toContain('investigate_area: 1200')
    expect(lines).toContain('search_entities: 300')
    expect(lines).toContain('TOTAL: 1750 calls, would-be 0.09')
  })

  it('says out loud that no envelope was applied', () => {
    const lines = formatInvoice(buildInvoice(usageBody() as never, 5)).join('\n')
    expect(lines).toContain('no free envelope is applied')
  })

  it('warns when the per-tool split does not add up to the key total', () => {
    const usage = usageBody({
      keys: [
        {
          keyId: 'key-1',
          userId: 'user-1',
          name: 'prod',
          prefix: 'wwv_aaaaaaaa',
          calls: 1500,
          tools: [{ toolName: 'investigate_area', calls: 1200, lastCallAt: null }],
        },
      ],
      totalCalls: 1500,
    })
    const lines = formatInvoice(buildInvoice(usage as never, 5)).join('\n')

    expect(lines).toContain('sums to 1200 but the key total is 1500')
    expect(lines).toContain('Do not invoice this line')
  })

  it('reports a month with no calls as zero rather than as an error', () => {
    const usage = usageBody({ keys: [], totalCalls: 0 })
    const lines = formatInvoice(buildInvoice(usage as never, 5)).join('\n')

    expect(lines).toContain('no key recorded a call in this period')
    expect(lines).toContain('TOTAL: 0 calls, would-be 0.00')
  })

  it('names a deleted key instead of printing an empty label', () => {
    const usage = usageBody({
      keys: [
        { keyId: 'key-9', userId: null, name: null, prefix: null, calls: 10, tools: [] },
      ],
      totalCalls: 10,
    })
    const lines = formatInvoice(buildInvoice(usage as never, 5)).join('\n')

    expect(lines).toContain('(deleted key)')
    expect(lines).toContain('(no prefix)')
    expect(lines).toContain('tools: (none)')
  })
})

describe('parseArgs', () => {
  it('reads both required arguments', () => {
    expect(parseArgs(['--period', '2026-11', '--rate-cents', '5'])).toEqual({
      period: '2026-11',
      rateCents: 5,
    })
  })

  it('accepts the --flag=value form', () => {
    expect(parseArgs(['--period=2026-11', '--rate-cents=5'])).toEqual({ period: '2026-11', rateCents: 5 })
  })

  it('refuses a missing or malformed period instead of defaulting to this month', () => {
    expect(() => parseArgs(['--rate-cents', '5'])).toThrow(/--period is required/)
    expect(() => parseArgs(['--period', '2026-13', '--rate-cents', '5'])).toThrow(/YYYY-MM/)
  })

  it('refuses a missing or nonsensical rate', () => {
    expect(() => parseArgs(['--period', '2026-11'])).toThrow(/--rate-cents is required/)
    expect(() => parseArgs(['--period', '2026-11', '--rate-cents', '-1'])).toThrow(/non-negative/)
    expect(() => parseArgs(['--period', '2026-11', '--rate-cents', 'free'])).toThrow(/non-negative/)
  })
})

/* ─────────────────────────── the whole runner ─────────────────────────── */

describe('the shadow-bill run', () => {
  it('prints a per-key invoice at the rate it was given', async () => {
    const stub = fetchStub(usageBody())
    vi.stubGlobal('fetch', stub.impl)

    await expect(main(['--period', '2026-11', '--rate-cents', '5'])).resolves.toBe(0)

    const lines = logLines(logSpy)
    expect(lines.some((line) => line.includes('wwv_aaaaaaaa'))).toBe(true)
    expect(lines.some((line) => line.includes('investigate_area: 1200'))).toBe(true)
    expect(lines.some((line) => line.includes('TOTAL: 1750 calls'))).toBe(true)
  })

  it('says out loud that the run is read-only', async () => {
    vi.stubGlobal('fetch', fetchStub(usageBody()).impl)

    await main(['--period', '2026-11', '--rate-cents', '5'])

    expect(logLines(logSpy).some((line) => line.includes('SHADOW BILL - READ-ONLY'))).toBe(true)
  })

  it('makes exactly one request, and it is a signed GET for the requested period', async () => {
    const stub = fetchStub(usageBody())
    vi.stubGlobal('fetch', stub.impl)

    await main(['--period', '2026-10', '--rate-cents', '5'])

    expect(stub.calls).toHaveLength(1)
    const [call] = stub.calls
    expect(call.method).toBe('GET')
    expect(new URL(call.url).pathname).toBe(GLOBE_USAGE_PATH)
    expect(new URL(call.url).searchParams.get('period')).toBe('2026-10')
    expect(call.body).toBeUndefined()
    expect(call.headers['X-Service-Signature']).toMatch(/^t=\d+,n=[0-9a-f-]+,sig=[0-9a-f]{64}$/)
  })

  it('makes NO mutating call of any kind: every request is a GET and carries no body', async () => {
    const stub = fetchStub(usageBody())
    vi.stubGlobal('fetch', stub.impl)

    await main(['--period', '2026-11', '--rate-cents', '5'])

    for (const call of stub.calls) {
      expect(call.method).toBe('GET')
      expect(call.body).toBeUndefined()
    }
    // Nothing else in the process may have been touched either: the runner opens
    // no database connection and imports no Stripe client.
    expect(stub.calls.every((call) => new URL(call.url).pathname === GLOBE_USAGE_PATH)).toBe(true)
  })

  it('prints the same invoice twice, so a re-run cannot double-bill', async () => {
    const first = fetchStub(usageBody())
    vi.stubGlobal('fetch', first.impl)
    await main(['--period', '2026-11', '--rate-cents', '5'])
    const firstLines = logLines(logSpy).filter((line) => !line.includes('GET https://'))

    logSpy.mockClear()
    const second = fetchStub(usageBody())
    vi.stubGlobal('fetch', second.impl)
    await main(['--period', '2026-11', '--rate-cents', '5'])

    expect(logLines(logSpy).filter((line) => !line.includes('GET https://'))).toEqual(firstLines)
    // Still one GET, still no writes: a second run is a second report, not a
    // second charge.
    expect(second.calls).toHaveLength(1)
  })

  it('fails by name when the globe has not deployed the usage route', async () => {
    vi.stubGlobal('fetch', fetchStub({ error: 'Not found' }, 404).impl)

    await expect(main(['--period', '2026-11', '--rate-cents', '5'])).rejects.toThrow(
      /404 for GET \/api\/service\/usage/,
    )
  })

  it('fails when the signature is refused', async () => {
    vi.stubGlobal('fetch', fetchStub({ error: 'Unauthorized' }, 401).impl)

    await expect(main(['--period', '2026-11', '--rate-cents', '5'])).rejects.toThrow(
      /CROSS_SERVICE_SECRET does not match/,
    )
  })

  it('refuses an unreadable body rather than invoicing it as zero calls', async () => {
    vi.stubGlobal('fetch', fetchStub('not json').impl)
    await expect(main(['--period', '2026-11', '--rate-cents', '5'])).rejects.toThrow(/not JSON/)

    vi.stubGlobal('fetch', fetchStub({ period: {}, keys: 'nope' }).impl)
    await expect(main(['--period', '2026-11', '--rate-cents', '5'])).rejects.toThrow(/no key list/)
  })

  it('names the missing setting instead of guessing an address', async () => {
    delete process.env.WWV_GLOBE_URL
    const stub = fetchStub(usageBody())
    vi.stubGlobal('fetch', stub.impl)

    await expect(main(['--period', '2026-11', '--rate-cents', '5'])).rejects.toThrow(/WWV_GLOBE_URL is not set/)
    expect(stub.calls).toHaveLength(0)
  })

  it('names the missing secret before making any request', async () => {
    delete process.env.CROSS_SERVICE_SECRET
    const stub = fetchStub(usageBody())
    vi.stubGlobal('fetch', stub.impl)

    await expect(main(['--period', '2026-11', '--rate-cents', '5'])).rejects.toThrow(
      /CROSS_SERVICE_SECRET is not set/,
    )
    expect(stub.calls).toHaveLength(0)
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
