// @ts-check
/**
 * The globe's tier-lock sweep: the only request this reconciler makes that is
 * not a read.
 *
 * WHY IT SENDS NOTHING BUT A SIGNATURE
 *   `POST /api/service/tier-lock-sweep` takes NO payload. Its handler runs
 *   `sweepTierLockDeadlines()` with no arguments and enforces the lock
 *   deadlines the globe has already armed on itself, in its own database, from
 *   normal signed tier-sync traffic. Its own comment says it is "safe to call as
 *   often as the scheduler likes".
 *
 *   That is deliberately a smaller thing than "here are the accounts to lock":
 *   there is no target list, so there is no way to send a wrong one. Account
 *   emails are used ONLY for the human-readable log line below. They are never
 *   sent, because there is nowhere to send them.
 *
 * THE BODY IS THE VERDICT, AND ALL FOUR COUNTS ARE REQUIRED
 *   The sweep answers `{success, due, locked, unapplied, failed, hasMore}`, and
 *   `success` is not a constant: the route computes it as `result.failed === 0`,
 *   so it says nothing at all about `unapplied`, and a body that simply never
 *   mentions a count is not a body that reported zero.
 *
 *   That is why this module alerts on the BODY and never on the status code. A
 *   PARTIAL sweep answers HTTP 200 with `success: false`, so a status-only check
 *   would report an all-clear for organizations that were due for enforcement
 *   and could not be enforced - a false clean bill from the job that is supposed
 *   to be the last line of defence. By the time the body is read the status is
 *   already 2xx, so it carries no information either way.
 *
 *   All four counts are required, and they are read in the order due, locked,
 *   unapplied, failed so a body missing one is refused by name and the message
 *   says which one. There is NO `Number()` coercion anywhere below: a count that
 *   arrived as the string `'0'` is a count this runner cannot trust, which is not
 *   the same thing as a healthy zero.
 *
 *   A body we cannot READ is not a passing sweep either. An empty or
 *   whitespace-only body, a body that is not JSON, and valid JSON that is not an
 *   object all fail the run rather than being skipped.
 *
 * TWO VARIABLES, NOT ONE
 *   CROSS_SERVICE_SECRET is half the configuration; the globe's base URL is the
 *   other half. The hub reaches this same service through PROVISIONING_API_URL,
 *   but that is a deployment variable and is not guaranteed to exist on a GitHub
 *   runner, so this module reads its own WWV_GLOBE_URL. Neither is defaulted: a
 *   missing one fails by name rather than aiming a signed request at whatever
 *   URL happened to be lying around.
 *
 * CROSS_SERVICE_SECRET is NOT a repository secret today (verified against
 * `gh secret list`: the repo has exactly LITELLM_API_KEY, OPENCODE_API_KEY,
 * STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and SUPABASE_DB_URL). Adding it is a
 * human step. Until it exists, a run that finds unpaid-but-granted drift fails
 * here on that specific missing variable rather than silently skipping the
 * sweep: a quietly skipped lock phase looks exactly like a healthy system.
 *
 * THE SIGNING IS A PORT, NOT AN INVENTION
 *   The canonical string and header shape below are a port of the hub's own
 *   reference implementation, src/lib/cross-service/sign.ts, and the test beside
 *   this file pins them against that file's own test vectors. A signature that
 *   is merely plausible is a request that fails 401 at 6am and looks like an
 *   outage.
 */

import crypto from 'node:crypto'

/** The globe endpoint this module exists to call. */
export const TIER_LOCK_SWEEP_PATH = '/api/service/tier-lock-sweep'

/** The globe's base URL. Read from here and nowhere else. */
export const GLOBE_URL_VAR = 'WWV_GLOBE_URL'

const REQUEST_TIMEOUT_MS = 30_000

/**
 * How many times a single run will ask the globe to sweep. The globe enforces
 * up to 500 armed deadlines per call, so three calls is 1500 in one night; past
 * that we are looking at a backlog no nightly job should quietly chew through.
 */
export const MAX_SWEEP_ROUNDS = 3

/**
 * The shared HMAC secret the globe verifies hub signatures with.
 * @returns {string} the secret
 */
export function requireCrossServiceSecret() {
  const secret = process.env.CROSS_SERVICE_SECRET
  if (!secret) {
    throw new Error(
      'CROSS_SERVICE_SECRET is not set, so the globe lock sweep cannot be requested. ' +
        'The Stripe-to-ledger comparison does not need it and has already finished. ' +
        'Adding it is a human step: repository Settings -> Secrets and variables -> Actions -> ' +
        'New repository secret. Use the same value the globe verifies hub signatures with. ' +
        'Until then, every scheduled run that finds unpaid-but-granted drift will fail here on purpose.',
    )
  }
  return secret
}

/**
 * The globe's base URL, which is the other half of the sweep's configuration.
 * @returns {string} a base URL with no trailing slash
 */
export function requireGlobeUrl() {
  const url = process.env.WWV_GLOBE_URL
  if (!url) {
    throw new Error(
      `${GLOBE_URL_VAR} is not set, so the globe lock sweep has no address to send its request to. ` +
        'The Stripe-to-ledger comparison does not need it and has already finished. ' +
        'Set it to the globe\'s base URL (for example https://cloud-wwv.dev). ' +
        'The hub reaches that same service through PROVISIONING_API_URL, but that is a deployment ' +
        'variable and is not guaranteed to exist on a GitHub runner, so this runner does not read it ' +
        'and does not guess a default. In the workflow it comes from the repository variable ' +
        `${GLOBE_URL_VAR}.`,
    )
  }
  return url.replace(/\/+$/, '')
}

/** @param {string} input */
function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * Port of normalizeTimestamp in src/lib/cross-service/sign.ts. The globe expects
 * SECONDS since the epoch with a +/-300s window; a 13-digit millisecond value
 * would always be rejected as expired, so anything far outside the window is
 * normalized down. This exact bug was fixed in hub commit 2c3bf7f - do not
 * reintroduce it.
 * @param {number} input
 */
function normalizeTimestamp(input) {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return input > nowSeconds + 300 ? Math.floor(input / 1000) : input
}

/**
 * Port of signCrossServiceRequest in src/lib/cross-service/sign.ts. The globe
 * verifies `sha256(body)` and builds its canonical string from
 * `new URL(request.url).pathname`, so the query string is never signed.
 *
 * An absent body hashes the EMPTY STRING rather than being skipped: the globe
 * still checks the body hash, so `sha256("")` is what a bodiless request must
 * carry.
 *
 * @param {{method: string, path: string, body?: unknown, timestamp?: number, secret: string}} opts
 * @returns {Record<string, string>} the three X-Service-* headers
 */
export function signCrossServiceRequest({ method, path, body, timestamp, secret }) {
  const nonce = crypto.randomUUID()
  const seconds = normalizeTimestamp(timestamp ?? Math.floor(Date.now() / 1000))

  const bodyStr = body === undefined ? '' : JSON.stringify(body)
  const bodyHash = sha256Hex(bodyStr)

  const signedPath = path.split('?')[0]
  const canonical = `${method}\n${signedPath}\n${seconds}\n${bodyHash}`
  const sig = crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex')

  return {
    'X-Service-Signature': `t=${seconds},n=${nonce},sig=${sig}`,
    'X-Service-Timestamp': String(seconds),
    'X-Service-Nonce': nonce,
  }
}

/**
 * The sweep's reply as an object, or a refusal.
 *
 * Named and lifted out of the request so the three ways a body can be
 * unreadable are each answered in one place with their own message: a blank
 * body, a body that is not JSON at all, and valid JSON that is not an object
 * (which covers an array, and also `null`). All three mean the same operational
 * thing - this run cannot say whether the due deadlines were enforced - and none
 * of them may be read as a clean sweep.
 *
 * @param {string} text the response body, verbatim
 * @returns {Record<string, unknown>} the parsed body, proven to be an object
 */
function parseSweepBody(text) {
  if (text.trim() === '') {
    throw new Error(
      'globe lock sweep returned an empty body, which is not a passing sweep: nothing in that ' +
        'response says the due deadlines were enforced.',
    )
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`globe lock sweep returned a body that is not JSON: ${text.slice(0, 300)}`)
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'globe lock sweep returned a body that is not an object: ' +
        `${Array.isArray(parsed) ? 'an array' : JSON.stringify(parsed)}. A sweep verdict is four ` +
        'named counts, so a body that cannot carry them is not a passing sweep. Body: ' +
        `${text.slice(0, 300)}`,
    )
  }

  return parsed
}

/**
 * The globe's sweep body is four counts, and the counts are the truth. The route
 * computes its `success` flag as `failed === 0`, so that flag says nothing at
 * all about `unapplied`, and a body that simply never mentions a count is not a
 * body that reported zero.
 *
 * @param {unknown} value the raw field
 * @param {string} field the field's name, for the message only
 * @param {string} bodyText the whole body, for the message only
 * @returns {number}
 */
function requireCount(value, field, bodyText) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `globe lock sweep reported ${field} as ${JSON.stringify(value ?? null)} instead of a number, ` +
        'so this run cannot say how much of the backlog was actually swept. A count that is absent ' +
        'is not a count of zero, and this runner will not turn one into the other: refusing to ' +
        `report a clean sweep. Body: ${bodyText.slice(0, 300)}`,
    )
  }
  return value
}

/**
 * A sweep's counts as the log fragment the per-round line is built from. Every
 * count is named every time, with no optional field left to omit: all four are
 * required by `requireCount`, so a reply that did not carry one never reaches a
 * log line at all, and the shape of that line lives in one place in this module
 * rather than inside a template literal. The runner writes its own closing line,
 * which is these same four counts in this same order.
 *
 * @param {{due: number, locked: number, unapplied: number, failed: number}} counts
 * @returns {string}
 */
export function describeSweepCounts(counts) {
  return `due=${counts.due} locked=${counts.locked} unapplied=${counts.unapplied} failed=${counts.failed}`
}

/**
 * One signed sweep request. Carries no payload.
 * @param {string} baseUrl
 * @param {string} secret
 */
async function sweepOnce(baseUrl, secret) {
  const response = await fetch(`${baseUrl}${TIER_LOCK_SWEEP_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...signCrossServiceRequest({ method: 'POST', path: TIER_LOCK_SWEEP_PATH, secret }),
    },
    // Empty on purpose: the globe reads this as sha256(""). Sending the account
    // emails here would imply a target list the route does not have.
    body: '',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `globe lock sweep failed with HTTP ${response.status}: ${text.slice(0, 300)}`,
    )
  }

  const parsed = parseSweepBody(text)
  // The status is already 2xx here, so it says nothing. Alert on the body: a
  // partial sweep is a 200 with `success: false`, and calling that healthy is
  // precisely the silent failure this reconciler exists to prevent.
  if (parsed.success !== true) {
    throw new Error(`globe lock sweep reported failure: ${text.slice(0, 300)}`)
  }

  // Read one by one rather than defaulted: `Number(parsed.due ?? 0)` turns a
  // body that never mentioned `due` into a report of zero deadlines, which looks
  // exactly like a healthy sweep and is the one thing this runner must not do.
  const due = requireCount(parsed.due, 'due', text)
  const locked = requireCount(parsed.locked, 'locked', text)
  const unapplied = requireCount(parsed.unapplied, 'unapplied', text)
  const failed = requireCount(parsed.failed, 'failed', text)

  // Checks `failed` as well as the flag. The globe sets the flag from this same
  // count today, so this is belt-and-braces - but it is the count that decides,
  // not a summary that a future route could compute differently.
  if (failed > 0) {
    throw new Error(
      `globe lock sweep reported failure: ${failed} of ${due} due deadline(s) could not be applied ` +
        `(locked=${locked}, unapplied=${unapplied}). Body: ${text.slice(0, 300)}`,
    )
  }

  // A nonzero `unapplied` is NOT a failure: a deadline can come due and need no
  // action taken on it. It is still never rounded away - the caller logs it and
  // returns it, so the run shows what the sweep actually did.
  return { due, locked, unapplied, failed, hasMore: parsed.hasMore === true }
}

/**
 * Ask the globe to enforce the free-plan lock deadlines it has already armed on
 * itself. Signed, bodiless, POST-only.
 *
 * The globe batches up to 500 deadlines per call; `hasMore` means there are
 * more waiting, so this re-asks a small bounded number of times. If it is still
 * true after that, the run FAILS rather than reporting a clean sweep: silently
 * dropping the remainder is exactly the failure mode this reconciler exists to
 * catch.
 *
 * The returned counts describe the LAST call, not a total across calls: each
 * call reports on the batch it was handed, and every round is logged as it
 * happens, so nothing is lost by not adding them up.
 *
 * @param {{emails?: string[]}} [input] accounts that motivated the sweep - for
 *   the log line only, and never part of the request
 * @returns {Promise<{rounds: number, due: number, locked: number, unapplied: number, failed: number, hasMore: boolean}>}
 */
export async function requestTierLockSweep({ emails = [] } = {}) {
  // Both checked before anything else so a missing setting is reported by name,
  // and check-secret-first keeps the two messages from ever fighting.
  const secret = requireCrossServiceSecret()
  const baseUrl = requireGlobeUrl()

  const accounts = Array.isArray(emails) ? emails.filter(Boolean) : []
  console.log(
    `[reconcile] sweep: ${accounts.length} account(s) with a lapsed grant: ${accounts.join(', ') || '(no email)'}`,
  )
  console.log(
    `[reconcile] sweep: POST ${baseUrl}${TIER_LOCK_SWEEP_PATH} (signed, no payload). ` +
      'The globe enforces the deadlines it has already armed on itself; no account is named in the request.',
  )

  let rounds = 0
  let last = { due: 0, locked: 0, unapplied: 0, failed: 0, hasMore: false }

  for (;;) {
    rounds += 1
    last = await sweepOnce(baseUrl, secret)
    console.log(`[reconcile] sweep round ${rounds}: ${describeSweepCounts(last)}`)
    if (last.unapplied > 0) {
      console.log(
        `[reconcile] sweep WARNING: the globe reported ${last.unapplied} due deadline(s) it did not ` +
          'apply. That is not necessarily an error - a deadline can come due and need no action - ' +
          'but it is the first number to look at if a lock you expected is missing.',
      )
    }

    if (!last.hasMore) {
      return {
        rounds,
        due: last.due,
        locked: last.locked,
        unapplied: last.unapplied,
        failed: last.failed,
        hasMore: false,
      }
    }
    if (rounds >= MAX_SWEEP_ROUNDS) {
      throw new Error(
        `the globe still reports hasMore after ${rounds} sweeps ` +
          `(last call: due=${last.due}, locked=${last.locked}, unapplied=${last.unapplied}). More ` +
          `armed deadlines exist than one run will process, so the remainder was NOT swept. This is ` +
          `a backlog, not a transient: check the globe's lock scheduler.`,
      )
    }
  }
}
