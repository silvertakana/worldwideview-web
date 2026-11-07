/**
 * Shadow-bill report: what the period WOULD have billed, per key, per tool.
 *
 *   pnpm billing-usage-report --period 2026-11 --rate-cents 5
 *
 * READ-ONLY, AND PROVABLY SO. This runner makes exactly one HTTP request, a
 * signed GET against the globe's /api/service/usage. It never calls Stripe, it
 * holds no database connection, and it writes nothing anywhere: there is no
 * posting mode in this file yet, so there is nothing to disable. The test beside
 * it asserts that any request arriving at the globe stub is a GET, which is the
 * mechanical form of that promise rather than a comment.
 *
 * WHY THE COUNTS COME FROM THE GLOBE AND NOT FROM POSTGRES. The hub and the globe
 * may sit on one Postgres, but the usage table's shape is owned by this repo's
 * Prisma migrations, so a second reader would be a second schema contract. The
 * signed route is the boundary that survives either topology, and it is the same
 * one the hub already uses for tier.
 *
 * WHAT IT PRINTS. Per key: the prefix, the label, the call count, the per-tool
 * split, and the would-be amount at the rate the caller passed. Then one total.
 * No envelope, no proration, no currency symbol: none of those have been decided,
 * and a report that invented one would be quoted as if it had.
 *
 * THE RATE IS AN ARGUMENT. The per-thousand-call price is not settled, so it is
 * not a constant anywhere in this repository.
 */

import { pathToFileURL } from 'node:url'
import { parseArgs, buildInvoice, formatInvoice } from './lib/billing-usage-core.mjs'
// ONE PORT OF THE CANONICAL SIGNING. This module's signature scheme is a port of
// the hub's own src/lib/cross-service/sign.ts, and that copy is already pinned
// against the reference test vectors next to it. A second copy here would be a
// second chance to drift, so the signer is imported rather than re-derived.
import { signCrossServiceRequest } from './lib/globe-tier-lock-sweep.mjs'

/** The one endpoint this runner talks to. */
export const GLOBE_USAGE_PATH = '/api/service/usage'

const REQUEST_TIMEOUT_MS = 30_000

/**
 * The two settings this runner needs, checked here rather than in the shared
 * sweep module: a missing variable has to be reported in THIS runner's terms, and
 * "the lock sweep cannot run" is the wrong sentence to hand an operator who asked
 * for a usage report.
 * @returns {{ secret: string, baseUrl: string }}
 */
function requireConfig() {
  const secret = process.env.CROSS_SERVICE_SECRET
  if (!secret) {
    throw new Error(
      'CROSS_SERVICE_SECRET is not set, so the globe will refuse the signed read this report needs. ' +
        'Set it to the same value the globe verifies hub signatures with. Nothing has been reported ' +
        'and nothing has been written.',
    )
  }

  const rawBase = process.env.WWV_GLOBE_URL
  if (!rawBase) {
    throw new Error(
      'WWV_GLOBE_URL is not set, so the usage report has no address to read. Set it to the globe\'s ' +
        'base URL (for example https://cloud-wwv.dev). This runner does not read PROVISIONING_API_URL: ' +
        'that is a deployment variable and is not guaranteed to exist on a CI runner.',
    )
  }

  return { secret, baseUrl: rawBase.replace(/\/+$/, '') }
}

/**
 * One signed GET. There is no other kind of request in this file.
 * @param {string} baseUrl
 * @param {string} secret
 * @param {string} period
 * @returns {Promise<{ period: {start: string, end: string, label: string}, keys: any[], totalCalls: number }>}
 */
async function readGlobeUsage(baseUrl, secret, period) {
  const search = new URLSearchParams({ period })
  const response = await fetch(`${baseUrl}${GLOBE_USAGE_PATH}?${search.toString()}`, {
    method: 'GET',
    headers: signCrossServiceRequest({ method: 'GET', path: GLOBE_USAGE_PATH, secret }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  const text = await response.text()

  if (!response.ok) {
    // 404 here means the globe has not deployed the usage route yet, which is a
    // deploy that is behind rather than a month with no calls. Saying so by name
    // is what stops it being read as a zero invoice.
    if (response.status === 404) {
      throw new Error(
        `the globe answered 404 for GET ${GLOBE_USAGE_PATH}, so it has not deployed the usage route. ` +
          'That is a deploy that is behind, not a month with no calls: this run has no number to report.',
      )
    }
    if (response.status === 401) {
      throw new Error(
        `the globe refused this runner's signature (401) for GET ${GLOBE_USAGE_PATH}. ` +
          'CROSS_SERVICE_SECRET does not match between the hub and the globe.',
      )
    }
    throw new Error(`the globe answered ${response.status} for GET ${GLOBE_USAGE_PATH}: ${text.slice(0, 300)}`)
  }

  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`the globe returned a body that is not JSON: ${text.slice(0, 300)}`)
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('the globe returned a body that is not an object, so it cannot carry a usage report.')
  }
  if (!Array.isArray(body.keys) || typeof body.totalCalls !== 'number') {
    throw new Error(
      'the globe returned a body with no key list and no total, so it is not a usage report. ' +
        'An unreadable body must never be invoiced as a month of zero calls.',
    )
  }

  return body
}

/**
 * Returns the exit code rather than setting one, so a test can drive the whole
 * runner without a shell.
 * @param {string[]} [argv]
 * @returns {Promise<number>} 0 when a report was printed, 1 when it could not be
 */
export async function main(argv = process.argv.slice(2)) {
  // Both settings are checked before any request, so a missing one is reported by
  // name rather than aiming a signed request at a guessed address.
  const { secret, baseUrl } = requireConfig()
  const { period, rateCents } = parseArgs(argv)

  console.log(`[usage-report] GET ${baseUrl}${GLOBE_USAGE_PATH}?period=${period} (signed, read-only)`)
  const usage = await readGlobeUsage(baseUrl, secret, period)
  const invoice = buildInvoice(usage, rateCents)

  for (const line of formatInvoice(invoice)) console.log(line)

  return 0
}

// Run only when executed directly; importing this file (from the test) must not
// start a report.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error('')
    console.error(`[usage-report] FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
