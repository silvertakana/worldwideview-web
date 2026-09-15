// @ts-check
/**
 * Pure detectors for the two durable queues the billing launch created, and the
 * read side that neither had.
 *
 * WHY THIS EXISTS
 *   Two fixes made failure durable and then nothing looked:
 *
 *   - D1 (fix/billing-launch-hardening) leaves a webhook event UNFINISHED
 *     (`processed_at IS NULL`, `last_error` set) when a delivery throws partway,
 *     so a Stripe redelivery can finish the work. Until something reads those
 *     rows, a payment event that was claimed and never completed is invisible.
 *   - D8 writes a `billing_failures` row when provisioning or the tier-sync call
 *     fails for a reason a Stripe retry will not fix. Until something reads that
 *     table, "a customer paid and got no workspace" is invisible.
 *
 *   Both tables were write-only. This module is the read.
 *
 * WHAT IT DOES NOT DO
 *   It reports. It does not reprocess an event, retry provisioning, resolve a
 *   failure, or change a grant. Repair is an operator's decision, for the same
 *   reason tier correction is: this reconciler detects, sweeps and alerts.
 *
 * CONTRACT: pure. No I/O, no database, no clock beyond the one the caller
 * injects. The runner feeds it rows; the tests feed it fixtures.
 */

/** One hour. See STUCK_EVENT_NOTE below before changing it. */
export const STUCK_EVENT_THRESHOLD_MS = 60 * 60 * 1000

/** How many rows of a backlog the log prints. The COUNT is always exact. */
export const SAMPLE_LIMIT = 20

/** The two stages the CHECK constraint on billing_failures permits. */
export const FAILURE_STAGES = ['provision', 'tier_sync']

/**
 * @typedef {Object} UnfinishedEvent
 * @property {string} event_id
 * @property {string|Date|null} [last_attempt_at]
 * @property {string|null} [last_error]
 *
 * @typedef {Object} FailureRow
 * @property {string} id
 * @property {string|null} [user_id]
 * @property {string|null} [email]
 * @property {string|null} [event_id]
 * @property {string|null} [event_type]
 * @property {string} stage
 * @property {string|null} [error]
 * @property {number} [attempts]
 * @property {string|Date|null} [first_seen_at]
 * @property {string|Date|null} [last_attempt_at]
 * @property {string|null} [resolved_at]
 *
 * @typedef {Object} StuckEvent
 * @property {string} eventId
 * @property {string|Date|null} lastAttemptAt
 * @property {string|null} lastError
 * @property {number} ageMs
 *
 * @typedef {Object} FailureItem
 * @property {string|null} id
 * @property {string} stage
 * @property {string} identity
 * @property {string|null} email
 * @property {string|null} userId
 * @property {string|null} eventId
 * @property {string|null} eventType
 * @property {number|null} attempts
 * @property {string|Date|null} firstSeenAt
 * @property {string|Date|null} lastAttemptAt
 * @property {number|null} ageMs               how long this has been open
 * @property {number|null} sinceLastAttemptMs
 */

/**
 * @param {unknown} value
 * @returns {number|null} epoch ms, or null when absent or unparseable
 */
function instant(value) {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * STUCK_EVENT_NOTE - what "stuck" can and cannot mean.
 *
 * Stripe retries a failed delivery with backoff for days, and the D1 design
 * deliberately keeps `processed_at` NULL so a redelivery can finish the job. So
 * an event that failed an hour ago may still be retried successfully, and this
 * detector reports "unfinished and making no progress", which is a signal to
 * look, not a verdict that the event is lost. Raising the threshold trades
 * earlier warning for fewer false alarms; it is one constant, on purpose.
 *
 * ONE CASE THIS CANNOT SEE: a row with `processed_at IS NULL` and
 * `last_attempt_at IS NULL`. That is a claim whose handler neither completed nor
 * recorded a failure (a killed process, or a failed best-effort failure write).
 * The ledger has NO column recording when the claim happened (`id` is a v4 UUID,
 * which carries no time), so such a row is indistinguishable from one claimed
 * seconds ago and still in flight. Thresholding it would alert on every webhook
 * currently being processed, so it is excluded. Closing that gap needs a
 * `claimed_at` column on the D1 migration, not a change here.
 *
 * Pick the unfinished events old enough to be worth an operator's attention.
 * @param {{events?: UnfinishedEvent[], now?: number, thresholdMs?: number, sampleLimit?: number}} [input]
 */
export function selectStuckEvents({
  events = [],
  now = Date.now(),
  thresholdMs = STUCK_EVENT_THRESHOLD_MS,
  sampleLimit = SAMPLE_LIMIT,
} = {}) {
  /** @type {StuckEvent[]} */
  const stuck = []

  for (const event of events) {
    const attempted = instant(event.last_attempt_at)
    // See the null case above: no timestamp means no way to tell in-flight from
    // abandoned, so it is not reported rather than reported wrongly.
    if (attempted === null) continue
    const ageMs = now - attempted
    // Strictly older: a row exactly at the threshold is not yet stuck.
    if (ageMs <= thresholdMs) continue
    stuck.push({
      eventId: event.event_id ?? '(no event id)',
      lastAttemptAt: event.last_attempt_at ?? null,
      lastError: event.last_error ?? null,
      ageMs,
    })
  }

  // Oldest first: the longest-abandoned event is the one most likely to be lost.
  stuck.sort((a, b) => b.ageMs - a.ageMs)

  return {
    count: stuck.length,
    thresholdMs,
    oldestAgeMs: stuck.length > 0 ? stuck[0].ageMs : null,
    sample: stuck.slice(0, sampleLimit),
  }
}

/**
 * Summarise the operator's failure queue: everything in `billing_failures` that
 * nobody has resolved, oldest first.
 * @param {{failures?: FailureRow[], now?: number, sampleLimit?: number}} [input]
 */
export function summarizeFailures({ failures = [], now = Date.now(), sampleLimit = SAMPLE_LIMIT } = {}) {
  /** @type {FailureItem[]} */
  const open = []
  /** @type {Map<string, number>} */
  const tally = new Map()

  for (const failure of failures) {
    // The query already filters this, and the pure function still checks: the
    // count it returns must mean "unresolved" without trusting its caller.
    if (failure.resolved_at) continue

    const firstSeen = instant(failure.first_seen_at)
    const lastAttempt = instant(failure.last_attempt_at)
    const stage = failure.stage ?? '(no stage)'
    tally.set(stage, (tally.get(stage) ?? 0) + 1)

    open.push({
      id: failure.id ?? null,
      stage,
      // Always something an operator can search by, in order of usefulness.
      identity: failure.email || failure.user_id || failure.event_id || failure.id || '(unidentified)',
      email: failure.email ?? null,
      userId: failure.user_id ?? null,
      eventId: failure.event_id ?? null,
      eventType: failure.event_type ?? null,
      attempts: typeof failure.attempts === 'number' ? failure.attempts : null,
      firstSeenAt: failure.first_seen_at ?? null,
      lastAttemptAt: failure.last_attempt_at ?? null,
      // ageMs is how long this has been BROKEN, measured from first_seen_at -
      // which is the axis the oldest-first ordering sorts on. How long since the
      // last attempt is a different fact and gets its own field, so neither
      // number can be read as the other.
      ageMs: firstSeen === null ? null : now - firstSeen,
      sinceLastAttemptMs: lastAttempt === null ? null : now - lastAttempt,
    })
  }

  open.sort((a, b) => (instant(a.firstSeenAt) ?? 0) - (instant(b.firstSeenAt) ?? 0))

  return {
    count: open.length,
    // Pairs rather than an object: the stage value comes from the database, and
    // a computed key on a record is both a lint error and a lost index signature.
    /** @type {Array<[string, number]>} */
    byStage: [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    oldestAgeMs: open.length > 0 ? open[0].ageMs : null,
    sample: open.slice(0, sampleLimit),
  }
}
