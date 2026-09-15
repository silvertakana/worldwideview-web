// @ts-check
/**
 * The two durable queues that hold payments which arrived and did not finish,
 * read by the nightly reconciler. Nothing in this file writes, and nothing in it
 * decides.
 *
 * WHY THIS FILE EXISTS
 *   `webhook_events` (a Stripe event that was claimed and never completed) and
 *   `billing_failures` (a provision or tier-sync step that failed in a way a
 *   Stripe redelivery cannot fix) are both written by the webhook and, until
 *   this reader existed, read by nothing. A record nobody reads cannot alert
 *   anyone, and a red scheduled run is this repository's ONLY alerting path.
 *   The Stripe-versus-ledger comparison cannot cover these rows either: an event
 *   that never finished writing its record is missing from BOTH lists, so that
 *   comparison sees nothing wrong.
 *
 * DETECT, NEVER CORRECT
 *   Nothing here issues an UPDATE, a DELETE or an upsert. Deciding that a failed
 *   handover is safe to forget is a person's call, and the wrong automatic
 *   answer takes something away from a customer who paid for it.
 *
 * WHY IT DOES NOT IMPORT src/lib/billing/records.ts
 *   `listUnresolvedFailures()` there reads the same rows, but through
 *   createAdminClient(), which needs a Supabase URL and a service-role key.
 *   Neither exists as a repository secret, and the only credential that reaches
 *   this database from a GitHub runner is SUPABASE_DB_URL. So the same rows are
 *   read over the same connection the ledger read uses, with `pg` rather than
 *   PostgREST.
 *
 * TWO SHAPES OF webhook_events, NOT ONE
 *   20260806000001 created the table as
 *   `processed_at TIMESTAMPTZ NOT NULL DEFAULT now()`, a shape in which an
 *   unfinished row cannot exist at all. 20260915000001 drops that DEFAULT and
 *   that NOT NULL in one statement and adds `last_error` and `last_attempt_at`
 *   in a second, so a half-applied migration leaves a nullable `processed_at`
 *   with no timestamp to age an unfinished event against. Which shape is in
 *   front of us is read from the catalogue, never assumed.
 *
 * AN EMPTY QUEUE AND AN ABSENT TABLE ARE DIFFERENT ANSWERS
 *   "Nothing is stuck" and "there is nowhere for a stuck payment to be recorded"
 *   look the same from a log line and mean opposite things to an operator, so a
 *   missing table is reported as its own clearly-labelled state. It does not
 *   fail the run - an absent table is a missing migration, not a billing
 *   incident - but it is never folded into a clean result either.
 */

/** An event claimed longer ago than this is stuck, not in flight. */
export const UNFINISHED_EVENT_THRESHOLD_MS = 15 * 60 * 1000

/** Where a payment that arrived and never finished is recorded. */
export const WEBHOOK_EVENTS_TABLE = 'webhook_events'

/** Where a step that failed in a way Stripe cannot retry away is recorded. */
export const BILLING_FAILURES_TABLE = 'billing_failures'

/**
 * A query function bound to the reconciler's own pool. The rows are `unknown`
 * on purpose: everything this module reads arrives from the database already
 * untrusted, and the reader's job is to prove the shape before using it.
 * @typedef {(sql: string, params?: unknown[]) => Promise<{rows: unknown}>} QueryFn
 */

/**
 * @typedef {object} UnfinishedEvent
 * @property {string} eventId
 * @property {string|null} lastError
 * @property {string|null} lastAttemptAt ISO instant, or null when the schema
 *   records no attempt stamp for this row
 */

/**
 * @typedef {object} UnresolvedFailure
 * @property {string} stage
 * @property {number} attempts
 * @property {string|null} firstSeenAt
 */

/**
 * @typedef {object} DurableQueueReading
 * @property {string[]} absentTables tables that do not exist here at all
 * @property {string[]} problems reasons a queue that DOES exist could not be read
 * @property {boolean} canAgeEvents whether an unfinished event carries a timestamp
 * @property {UnfinishedEvent[]} unfinishedEvents
 * @property {UnresolvedFailure[]} unresolvedFailures
 */

/**
 * @typedef {object} DurableQueueVerdict
 * @property {boolean} ok no reason to fail the run was found
 * @property {string[]} failures reasons the run must go red
 * @property {string[]} warnings loud, but not red: a queue that is not deployed,
 *   or rows that cannot be aged
 */

/**
 * pg_catalog, not information_schema, on purpose: information_schema hides
 * tables and columns the connecting role holds no privilege on, and
 * `webhook_events` is locked down with RLS and no GRANT at all, so it would
 * report "no such table" for a table that is sitting right there. The catalogue
 * always answers, and it answers for both shapes.
 */
const TABLE_COLUMNS_SQL = `
  SELECT c.relname AS table_name, a.attname AS column_name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
   WHERE n.nspname = 'public'
     AND c.relname = ANY($1::text[])
     AND a.attnum > 0
     AND a.attisdropped = false
`

/**
 * The extended shape, and the only one in which a row can be unfinished at all.
 * Timestamps are rendered in SQL so the reader never has to guess whether the
 * driver handed back a Date or a string, and NULLS FIRST puts the rows with no
 * stamp at all in front of the ones that can be aged.
 */
const UNFINISHED_EVENTS_WITH_STAMP_SQL = `
  SELECT event_id,
         last_error,
         to_char(last_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_attempt_at
    FROM public.webhook_events
   WHERE processed_at IS NULL
   ORDER BY last_attempt_at NULLS FIRST, event_id
`

/** The shape with no stamp columns: the rows exist, their age does not. */
const UNFINISHED_EVENTS_NO_STAMP_SQL = `
  SELECT event_id
    FROM public.webhook_events
   WHERE processed_at IS NULL
   ORDER BY event_id
`

/**
 * The operator's work queue, oldest first - the same rows and the same order as
 * records.ts's listUnresolvedFailures(), over a connection that exists here.
 */
const UNRESOLVED_FAILURES_SQL = `
  SELECT stage,
         attempts,
         to_char(first_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first_seen_at
    FROM public.billing_failures
   WHERE resolved_at IS NULL
   ORDER BY first_seen_at ASC, stage ASC
`

/** Columns an unresolved row cannot be read without. */
const REQUIRED_FAILURE_COLUMNS = ['stage', 'attempts', 'first_seen_at', 'resolved_at']

/** How many event ids a message names before it stops listing them. */
const MAX_NAMED_EVENTS = 5

/**
 * The driver's rows, or null when it handed back something this reader cannot
 * interpret. A result that is not a rows array is "we do not know", and "we do
 * not know" is never allowed to read as a clean queue.
 * @param {unknown} result
 * @returns {Record<string, unknown>[]|null}
 */
function asRows(result) {
  if (typeof result !== 'object' || result === null) return null
  const rows = /** @type {{rows?: unknown}} */ (result).rows
  if (!Array.isArray(rows)) return null
  /** @type {Record<string, unknown>[]} */
  const out = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return null
    out.push(/** @type {Record<string, unknown>} */ (row))
  }
  return out
}

/**
 * An instant, or null when the column carried nothing. A value that is present
 * but unreadable is NOT null: the two need opposite responses, so the caller is
 * told which one it has.
 * @param {unknown} value
 * @returns {{ok: true, iso: string|null} | {ok: false}}
 */
function readInstant(value) {
  if (value === null || value === undefined) return { ok: true, iso: null }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? { ok: true, iso: value.toISOString() } : { ok: false }
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? { ok: true, iso: new Date(ms).toISOString() } : { ok: false }
  }
  return { ok: false }
}

/**
 * Plain-language age, because "900000 ms" is not a thing anyone reads.
 * @param {number} ms
 */
function formatAge(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/**
 * Event ids for a message, capped so a backlog cannot flood the log.
 * @param {UnfinishedEvent[]} events
 */
function nameEvents(events) {
  const ids = events.map((event) => event.eventId)
  if (ids.length <= MAX_NAMED_EVENTS) return ids.join(', ')
  return `${ids.slice(0, MAX_NAMED_EVENTS).join(', ')} and ${ids.length - MAX_NAMED_EVENTS} more`
}

/**
 * `provision=2, tier_sync=1`, in a stable order. A Map, never a keyed object.
 * @param {UnresolvedFailure[]} failures
 */
function summarizeStages(failures) {
  /** @type {Map<string, number>} */
  const byStage = new Map()
  for (const failure of failures) {
    byStage.set(failure.stage, (byStage.get(failure.stage) ?? 0) + 1)
  }
  return [...byStage.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([stage, count]) => `${stage}=${count}`)
    .join(', ')
}

/**
 * Which of the two tables exist here, and which columns they have.
 * @param {QueryFn} query
 * @returns {Promise<Map<string, string[]>>}
 */
async function readTableColumns(query) {
  const rows = asRows(
    await query(TABLE_COLUMNS_SQL, [[WEBHOOK_EVENTS_TABLE, BILLING_FAILURES_TABLE]]),
  )
  if (rows === null) {
    throw new Error(
      'could not read the column catalogue for the durable billing queues: the database returned ' +
        'something this reader cannot interpret, so it cannot tell an empty queue from a missing ' +
        'table and will not report either as clean.',
    )
  }

  /** @type {Map<string, string[]>} */
  const columnsByTable = new Map()
  for (const row of rows) {
    const table = row.table_name
    const column = row.column_name
    if (typeof table !== 'string' || table.length === 0 || typeof column !== 'string') {
      throw new Error(
        'could not read the column catalogue for the durable billing queues: a row arrived without ' +
          'a usable table and column name, so the shape of these queues is unknown.',
      )
    }
    const existing = columnsByTable.get(table)
    if (existing === undefined) columnsByTable.set(table, [column])
    else existing.push(column)
  }
  return columnsByTable
}

/**
 * The `webhook_events` rows that were claimed and never completed.
 * @param {QueryFn} query
 * @param {string[]} columns
 * @returns {Promise<{ok: true, canAge: boolean, events: UnfinishedEvent[]} | {ok: false, problem: string}>}
 */
async function readUnfinishedEvents(query, columns) {
  if (!columns.includes('event_id') || !columns.includes('processed_at')) {
    return {
      ok: false,
      problem:
        `${WEBHOOK_EVENTS_TABLE} exists but has no event_id/processed_at pair, so the rows that were ` +
        'claimed and never completed cannot be found in it. That is a shape this reader does not ' +
        'know, which is not the same as an empty queue.',
    }
  }

  const canAge = columns.includes('last_attempt_at')
  const rows = asRows(
    await query(canAge ? UNFINISHED_EVENTS_WITH_STAMP_SQL : UNFINISHED_EVENTS_NO_STAMP_SQL),
  )
  if (rows === null) {
    return {
      ok: false,
      problem:
        `the read of ${WEBHOOK_EVENTS_TABLE} returned something this reader cannot interpret, so it ` +
        'cannot say whether any payment is stuck. Unknown is not empty.',
    }
  }

  /** @type {UnfinishedEvent[]} */
  const events = []
  for (const row of rows) {
    const eventId = row.event_id
    if (typeof eventId !== 'string' || eventId.length === 0) {
      return {
        ok: false,
        problem:
          `${WEBHOOK_EVENTS_TABLE} returned an unfinished row with no usable event_id. A row this ` +
          'reader cannot identify cannot be looked up by anyone either, so it is reported as ' +
          'unreadable rather than skipped.',
      }
    }

    let lastError = null
    if (columns.includes('last_error')) {
      const raw = row.last_error
      if (typeof raw === 'string') lastError = raw
      else if (raw !== null && raw !== undefined) {
        return {
          ok: false,
          problem: `${WEBHOOK_EVENTS_TABLE} returned a last_error for ${eventId} that is not text.`,
        }
      }
    }

    /** @type {string|null} */
    let lastAttemptAt = null
    if (canAge) {
      const stamp = readInstant(row.last_attempt_at)
      if (!stamp.ok) {
        return {
          ok: false,
          problem:
            `${WEBHOOK_EVENTS_TABLE} returned an unreadable last_attempt_at for ${eventId}, so how ` +
            'long that event has been unfinished cannot be worked out. Refusing to guess it.',
        }
      }
      lastAttemptAt = stamp.iso
    }

    events.push({ eventId, lastError, lastAttemptAt })
  }

  return { ok: true, canAge, events }
}

/**
 * The `billing_failures` rows nobody has resolved.
 * @param {QueryFn} query
 * @param {string[]} columns
 * @returns {Promise<{ok: true, rows: UnresolvedFailure[]} | {ok: false, problem: string}>}
 */
async function readUnresolvedFailures(query, columns) {
  for (const required of REQUIRED_FAILURE_COLUMNS) {
    if (!columns.includes(required)) {
      return {
        ok: false,
        problem:
          `${BILLING_FAILURES_TABLE} exists but has no ${required} column, so its unresolved rows ` +
          'cannot be read. That is a shape this reader does not know, which is not the same as an ' +
          'empty queue.',
      }
    }
  }

  const rows = asRows(await query(UNRESOLVED_FAILURES_SQL))
  if (rows === null) {
    return {
      ok: false,
      problem:
        `the read of ${BILLING_FAILURES_TABLE} returned something this reader cannot interpret, so ` +
        'it cannot say whether any handover is outstanding. Unknown is not empty.',
    }
  }

  /** @type {UnresolvedFailure[]} */
  const failures = []
  for (const row of rows) {
    const stage = row.stage
    if (typeof stage !== 'string' || stage.length === 0) {
      return {
        ok: false,
        problem: `${BILLING_FAILURES_TABLE} returned an unresolved row with no usable stage.`,
      }
    }
    const attempts = row.attempts
    if (typeof attempts !== 'number' || !Number.isFinite(attempts)) {
      return {
        ok: false,
        problem: `${BILLING_FAILURES_TABLE} returned a non-numeric attempts value for a ${stage} failure.`,
      }
    }
    const seen = readInstant(row.first_seen_at)
    if (!seen.ok) {
      return {
        ok: false,
        problem: `${BILLING_FAILURES_TABLE} returned an unreadable first_seen_at for a ${stage} failure.`,
      }
    }
    failures.push({ stage, attempts, firstSeenAt: seen.iso })
  }

  return { ok: true, rows: failures }
}

/**
 * Read both queues. Every failure here is answered, not thrown: one unreadable
 * queue must not hide the other, and the caller needs to know which is which.
 * @param {QueryFn} query a query function bound to the reconciler's own pool
 * @returns {Promise<DurableQueueReading>}
 */
export async function readDurableQueues(query) {
  const columnsByTable = await readTableColumns(query)
  const eventColumns = columnsByTable.get(WEBHOOK_EVENTS_TABLE) ?? []
  const failureColumns = columnsByTable.get(BILLING_FAILURES_TABLE) ?? []

  /** @type {DurableQueueReading} */
  const reading = {
    absentTables: [],
    problems: [],
    canAgeEvents: false,
    unfinishedEvents: [],
    unresolvedFailures: [],
  }

  if (eventColumns.length === 0) {
    reading.absentTables.push(WEBHOOK_EVENTS_TABLE)
  } else {
    const events = await readUnfinishedEvents(query, eventColumns)
    if (events.ok) {
      reading.canAgeEvents = events.canAge
      reading.unfinishedEvents = events.events
    } else {
      reading.problems.push(events.problem)
    }
  }

  if (failureColumns.length === 0) {
    reading.absentTables.push(BILLING_FAILURES_TABLE)
  } else {
    const failures = await readUnresolvedFailures(query, failureColumns)
    if (failures.ok) reading.unresolvedFailures = failures.rows
    else reading.problems.push(failures.problem)
  }

  return reading
}

/**
 * Turn a reading into the reasons this run must go red, and the things it must
 * say loudly without failing.
 *
 * The order matters for a reader: what could not be read, then what was read and
 * is wrong.
 *
 * @param {DurableQueueReading} reading
 * @param {Date} [now]
 * @returns {DurableQueueVerdict}
 */
export function gradeDurableQueues(reading, now = new Date()) {
  const nowMs = now.getTime()
  /** @type {string[]} */
  const failures = []
  /** @type {string[]} */
  const warnings = []

  for (const problem of reading.problems) failures.push(problem)

  for (const table of reading.absentTables) {
    warnings.push(
      `${table} does not exist in this database, so its queue was NOT read and the durable billing ` +
        'record is not deployed here. Nothing about payments that arrived and did not finish is ' +
        'being recorded anywhere an operator can see yet, and the Stripe-to-ledger comparison ' +
        'cannot cover it: an unfinished payment is missing from both of those lists. An absent ' +
        'table is a missing migration rather than a billing incident, which is why this warning ' +
        'does not fail the run - but it is NOT a clean result either.',
    )
  }

  // Rows that exist but cannot be aged. This is the half-applied-migration
  // shape: 20260915000001 makes processed_at nullable in one statement and adds
  // last_attempt_at in another, so there is a window where an unfinished row has
  // no timestamp at all. Those rows cannot be called stuck (the limit cannot be
  // measured against them) and must not be called fine, which leaves reporting
  // them as the incomplete answer they are.
  const unageable = reading.unfinishedEvents.filter((event) => event.lastAttemptAt === null)
  if (unageable.length > 0) {
    warnings.push(
      `${unageable.length} webhook event(s) are unfinished and this schema records no attempt ` +
        `timestamp to age them against (${nameEvents(unageable)}). They are older than they look ` +
        'and younger than they look, and this run can say neither, so treat it as INCOMPLETE rather ' +
        'than clean: applying the rest of the webhook_events migration gives them a timestamp.',
    )
  }

  for (const event of reading.unfinishedEvents) {
    if (event.lastAttemptAt === null) continue
    const ageMs = nowMs - Date.parse(event.lastAttemptAt)
    if (ageMs <= UNFINISHED_EVENT_THRESHOLD_MS) continue
    failures.push(
      `webhook event ${event.eventId} has been unfinished for ${formatAge(ageMs)}, past the ` +
        `${formatAge(UNFINISHED_EVENT_THRESHOLD_MS)} limit (last attempt: ${event.lastAttemptAt}). ` +
        `last_error: ${event.lastError ?? '(none recorded - the handler did not get as far as writing one)'}`,
    )
  }

  if (reading.unresolvedFailures.length > 0) {
    const oldest = reading.unresolvedFailures
      .map((failure) => failure.firstSeenAt)
      .filter((iso) => iso !== null)
      .sort()[0]
    failures.push(
      `${BILLING_FAILURES_TABLE} holds ${reading.unresolvedFailures.length} unresolved failure(s) ` +
        `(stages: ${summarizeStages(reading.unresolvedFailures)}` +
        `${oldest ? `, oldest ${formatAge(nowMs - Date.parse(oldest))}` : ''}). Stripe retrying the ` +
        'event will not clear these - they need a person - and nothing here resolves them on its own.',
    )
  }

  return { ok: failures.length === 0, failures, warnings }
}
