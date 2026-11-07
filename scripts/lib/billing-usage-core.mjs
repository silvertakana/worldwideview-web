// @ts-check
/**
 * The pure half of the shadow-bill report: argument parsing, the would-be
 * invoice maths, and the lines an operator reads.
 *
 * WHY THE MATHS IS PURE AND HERE. A shadow bill is a number a person will quote
 * in a meeting before any invoice exists. It has to be derivable without a
 * network, a database or a clock, so a disagreement can be settled by reading
 * the function rather than by re-running the job.
 *
 * NO FREE ENVELOPE IS APPLIED, and that is deliberate rather than an omission:
 * the envelope is a pricing decision that has not been made, and this phase
 * prints the raw count so that any future envelope is a one-line change to a
 * number that is visible rather than a discount buried in the arithmetic. The
 * report says so in its own header, so nobody reads the amount as a final bill.
 */

/** The rate is quoted in cents per thousand calls. */
export const CALLS_PER_RATE_UNIT = 1000

/**
 * @typedef {{ keyId: string, userId: string | null, name: string | null, prefix: string | null, calls: number, tools: Array<{toolName: string, calls: number}> }} KeyUsage
 * @typedef {{ start: string, end: string, label: string }} UsagePeriod
 * @typedef {{ keyId: string, name: string | null, prefix: string | null, userId: string | null, calls: number, amountCents: number, tools: Array<{toolName: string, calls: number}> }} KeyInvoice
 * @typedef {{ period: UsagePeriod, rateCents: number, totalCalls: number, totalAmountCents: number, keys: KeyInvoice[] }} Invoice
 */

/**
 * @param {string[]} argv
 * @returns {{ period: string, rateCents: number }}
 */
export function parseArgs(argv) {
  /** @type {Map<string, string>} */
  const values = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      values.set(arg.slice(2, eq), arg.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) continue
    values.set(arg.slice(2), next)
    i += 1
  }

  const period = values.get('period') ?? ''
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw new Error(
      `--period is required and must be YYYY-MM (got ${JSON.stringify(period)}). A report that ` +
        'quietly defaulted to the current month would answer a question nobody asked.',
    )
  }

  const rateRaw = values.get('rate-cents')
  const rateCents = Number(rateRaw)
  if (rateRaw === undefined || !Number.isFinite(rateCents) || rateCents < 0) {
    throw new Error(
      `--rate-cents is required and must be a non-negative number (got ${JSON.stringify(rateRaw ?? null)}). ` +
        'The price is an argument rather than a constant because it has not been decided.',
    )
  }

  return { period, rateCents }
}

/**
 * The would-be amount for a call count, in cents.
 *
 * Rounded to whole cents: an invoice is a money amount, and printing six decimal
 * places would invite somebody to quote one of them.
 * @param {number} calls
 * @param {number} rateCents
 * @returns {number}
 */
export function amountCentsFor(calls, rateCents) {
  return Math.round((calls * rateCents) / CALLS_PER_RATE_UNIT)
}

/**
 * Turns the globe's answer into a per-key invoice.
 *
 * Order comes from the globe (calls descending, then id), and is preserved:
 * re-sorting here would let the report and the API disagree about the order of
 * the same numbers.
 *
 * @param {{ period: UsagePeriod, keys: KeyUsage[], totalCalls?: number }} usage
 * @param {number} rateCents
 * @returns {Invoice}
 */
export function buildInvoice(usage, rateCents) {
  const keys = usage.keys.map((key) => ({
    keyId: key.keyId,
    name: key.name,
    prefix: key.prefix,
    userId: key.userId,
    calls: key.calls,
    amountCents: amountCentsFor(key.calls, rateCents),
    tools: key.tools.map((tool) => ({ toolName: tool.toolName, calls: tool.calls })),
  }))

  const totalCalls = keys.reduce((sum, key) => sum + key.calls, 0)

  return {
    period: usage.period,
    rateCents,
    totalCalls,
    // Summed from the per-key amounts rather than recomputed from the total, so
    // the printed total is exactly the sum of the printed lines.
    totalAmountCents: keys.reduce((sum, key) => sum + key.amountCents, 0),
    keys,
  }
}

/**
 * @param {number} cents
 * @returns {string} a fixed two-decimal amount, without a currency symbol
 */
export function formatCents(cents) {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, '0')
  return `${sign}${whole}.${frac}`
}

/**
 * The report as lines. Pure, so a test can assert the exact text an operator
 * will read without capturing the console.
 * @param {Invoice} invoice
 * @returns {string[]}
 */
export function formatInvoice(invoice) {
  const lines = []
  lines.push(
    '[usage-report] SHADOW BILL - READ-ONLY: one signed GET to the globe and nothing else. ' +
      'No invoice is created, no meter is posted and no subscription is changed.',
  )
  lines.push(
    '[usage-report] no free envelope is applied: the count below is every metered call in the ' +
      'period, so any future envelope is a visible subtraction rather than a hidden one.',
  )
  lines.push(`[usage-report] period: ${invoice.period.label} (${invoice.period.start} to ${invoice.period.end}, end exclusive)`)
  lines.push(`[usage-report] rate: ${invoice.rateCents} cents per ${CALLS_PER_RATE_UNIT} calls`)
  lines.push(`[usage-report] keys: ${invoice.keys.length}`)
  lines.push('')

  if (invoice.keys.length === 0) {
    lines.push('[usage-report] no key recorded a call in this period.')
  }

  for (const key of invoice.keys) {
    const label = key.name === null ? '(deleted key)' : key.name
    const prefix = key.prefix === null ? '(no prefix)' : key.prefix
    lines.push(
      `  ${prefix}  ${label}  key=${key.keyId}` +
        (key.userId === null ? '' : `  user=${key.userId}`),
    )
    lines.push(`    calls: ${key.calls}   would-be: ${formatCents(key.amountCents)}`)
    if (key.tools.length === 0) {
      lines.push('    tools: (none)')
    } else {
      const total = key.tools.reduce((sum, tool) => sum + tool.calls, 0)
      key.tools.forEach((tool, index) => {
        const branch = index === key.tools.length - 1 ? '└' : '├'
        lines.push(`    ${branch} ${tool.toolName}: ${tool.calls}`)
      })
      // A split that does not add up to the key total means the report is
      // dropping rows, which is worse than reporting fewer tools.
      if (total !== key.calls) {
        lines.push(
          `    WARNING: the per-tool split sums to ${total} but the key total is ${key.calls}. ` +
            'Do not invoice this line until that is explained.',
        )
      }
    }
    lines.push('')
  }

  lines.push(
    `[usage-report] TOTAL: ${invoice.totalCalls} calls, would-be ${formatCents(invoice.totalAmountCents)}`,
  )
  return lines
}
