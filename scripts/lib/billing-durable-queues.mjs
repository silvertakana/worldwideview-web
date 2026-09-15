// @ts-check
/**
 * The two durable queues that hold payments which arrived and did not finish,
 * read by the nightly reconciler. Nothing in this file writes, and nothing in it
 * repairs.
 *
 * WHY THIS FILE EXISTS
 *   `webhook_events` (a Stripe event that was claimed and never completed) and
 *   `billing_failures` (a provision or tier-sync step that failed in a way a
 *   Stripe redelivery cannot fix) are both written by the webhook and, until a
 *   reader existed, read by nothing. A record nobody reads cannot alert anyone,
 *   and a red scheduled run is this repository's ONLY alerting path. The
 *   Stripe-versus-ledger comparison cannot cover these rows either: an event that
 *   never finished writing its record is missing from BOTH lists, so that
 *   comparison sees nothing wrong.
 *
 * DETECT, NEVER CORRECT
 *   Nothing here issues an UPDATE, a DELETE or an upsert. Deciding that a failed
 *   handover is safe to forget is a person's call, and the wrong automatic answer
 *   takes something away from a customer who paid for it.
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
 *   missing table is reported as its own clearly-labelled state. It does not fail
 *   the run - an absent table is a missing migration, not a billing incident -
 *   but it is never folded into a clean result either.
 *
 * WHAT AN OPERATOR GETS OUT OF A READING
 *   `readDurableQueues` answers with rows; `summarizeUnfinishedEvents` and
 *   `summarizeUnresolvedFailures` turn those rows into something a person can act
 *   on, and `gradeDurableQueues` turns them into the reasons the run goes red.
 *   Both summaries are PURE - rows in, report out, no I/O, and no clock beyond
 *   the `now` the caller injects - because a threshold that is off by one
 *   comparison operator, or a NULL timestamp read as "ancient", turns a nightly
 *   alert into noise nobody reads, and the only way to pin that is a fixture.
 */

/** How long an unfinished event may sit still before it is stuck. */
export const UNFINISHED_EVENT_THRESHOLD_MS = 15 * 60 * 1000

/** Where a payment that arrived and never finished is recorded. */
export const WEBHOOK_EVENTS_TABLE = 'webhook_events'

/** Where a step that failed in a way Stripe cannot retry away is recorded. */
export const BILLING_FAILURES_TABLE = 'billing_failures'

/** How many rows of a backlog the log prints. The COUNT is always exact. */
export const SAMPLE_LIMIT = 20

/**
 * STUCK_EVENT_NOTE - what "stuck" can and cannot mean.
 *
 * Stripe retries a failed delivery with backoff for days, and the D1 design
 * deliberately keeps `processed_at` NULL so a redelivery can finish the job. So
 * an event whose last attempt was 20 minutes ago may still be retried
 * successfully, and this detector reports "unfinished and making no progress",
 * which is a signal to look, not a verdict that the event is lost. The window is
 * 15 minutes because the handler's own work is measured in seconds: anything
 * that has sat still for a quarter of an hour is not still running. Raising it
 * trades earlier warning for fewer false alarms; it is one constant, on purpose.
 *
 * ONE CASE THIS CANNOT SEE: a row with `processed_at IS NULL` AND
 * `last_attempt_at IS NULL`. That is a claim whose handler neither completed nor
 * recorded an attempt (a killed process, or a best-effort failure write that did
 * not land). The ledger has NO column recording when the claim happened (`id` is
 * a v4 UUID, which carries no time), so such a row is indistinguishable from one
 * claimed seconds ago and still in flight. Thresholding it would alert on every
 * webhook currently being processed, so it cannot be called stuck here - and it
 * cannot be called fine either, which is why gradeDurableQueues reports it as
 * the INCOMPLETE answer it is. Closing the gap needs a `claimed_at` column on the
 * 20260915000001 migration, not a change in this module.
 */

/**
 * A query function bound to the reconciler's own pool. The rows are `unknown`
 * on purpose: everything this module reads arrives from the database already
 * untrusted, and the reader's job is to prove the shape before using it.
 * @typedef {(sql: string, params?: unknown[]) => Promise<{rows: unknown}>} QueryFn
 */

/**
 * An unfinished webhook event, as this reader reports it. `email` and `userId`
 * are null when this schema's webhook_events carries no such column.
 * @typedef {object} UnfinishedEvent
 * @property {string} eventId
 * @property {string|null} lastError
 * @property {string|null} lastAttemptAt ISO instant, or null when the schema
 *   records no attempt stamp for this row
 * @property {string|null} email
 * @property {string|null} userId
 */

/**
 * An unresolved billing failure, as this reader reports it. `identity` is always
 * something an operator can search by, and `resolvedAt` is carried only because a
 * caller may hand this shape to the pure summary with a resolved row in it: the
 * query already filters those out.
 * @typedef {object} UnresolvedFailure
 * @property {string|null} id
 * @property {string} stage
 * @property {string} identity
 * @property {string|null} email
 * @property {string|null} userId
 * @property {string|null} eventId
 * @property {string|null} eventType
 * @property {number} attempts
 * @property {string|null} firstSeenAt
 * @property {string|null} lastAttemptAt
 * @property {string|null} [resolvedAt]
 */

/**
 * The fields the unfinished-event summary reads. `UnfinishedEvent`, which is what
 * the reader returns, satisfies this shape - and so does a bare fixture, which is
 * the point: the summary is pure and must be drivable without a database.
 * @typedef {object} EventRow
 * @property {string} eventId
 * @property {string|Date|number|null} [lastAttemptAt]
 * @property {string|null} [lastError]
 * @property {string|null} [email]
 * @property {string|null} [userId]
 */

/**
 * The fields the failure summary reads and reports on. `UnresolvedFailure`, which
 * is what the reader returns, satisfies this shape. Note what is NOT here: the
 * identity an operator searches by, because the summary derives it from the
 * fields below rather than trusting a value a caller could set to anything.
 * @typedef {object} FailureRow
 * @property {string|null} [id]
 * @property {string|null} [stage]
 * @property {string|null} [email]
 * @property {string|null} [userId]
 * @property {string|null} [eventId]
 * @property {string|null} [eventType]
 * @property {number|null} [attempts]
 * @property {string|Date|number|null} [firstSeenAt]
 * @property {string|Date|number|null} [lastAttemptAt]
 * @property {string|Date|null} [resolvedAt]
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
 * @property {boolean} complete nothing was left unread or unmeasurable - that
 *   is, no warnings: `false` means this run established less than a full answer
 * @property {string[]} failures reasons the run must go red
 * @property {string[]} warnings loud, but not red: a queue that is not deployed,
 *   or rows that cannot be aged
 */

/**
 * An unfinished event old enough to be worth an operator's attention, with how
 * long it has been unfinished.
 * @typedef {object} StuckEvent
 * @property {string} eventId
 * @property {string|null} lastAttemptAt
 * @property {string|null} lastError
 * @property {string|null} email
 * @property {string|null} userId
 * @property {number} ageMs
 */

/**
 * @typedef {object} UnfinishedEventSummary
 * @property {number} count exact, never the size of the sample
 * @property {number} thresholdMs the window this summary judged against
 * @property {number|null} oldestAgeMs null when nothing is stuck
 * @property {StuckEvent[]} sample the oldest rows, at most sampleLimit of them
 */

/**
 * One unresolved failure, ready to print.
 * @typedef {object} SummarizedFailure
 * @property {string|null} id
 * @property {string} stage
 * @property {string} identity
 * @property {string|null} email
 * @property {string|null} userId
 * @property {string|null} eventId
 * @property {string|null} eventType
 * @property {number|null} attempts
 * @property {string|null} firstSeenAt
 * @property {string|null} lastAttemptAt
 * @property {number|null} ageMs how long this has been OPEN, from firstSeenAt
 * @property {number|null} sinceLastAttemptMs a different fact, and its own field
 */

/**
 * @typedef {object} UnresolvedFailureSummary
 * @property {number} count exact, never the size of the sample
 * @property {Array<[string, number]>} byStage most frequent first, ties
 *   alphabetical
 * @property {number|null} oldestAgeMs null when nothing is unresolved
 * @property {SummarizedFailure[]} sample the oldest rows, oldest first
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

/** Columns an unresolved row cannot be read without. */
const REQUIRED_FAILURE_COLUMNS = ['stage', 'attempts', 'first_seen_at', 'resolved_at']

/** How many event ids a message names before it stops listing them. */
const MAX_NAMED_EVENTS = 5

/**
 * The one name pattern a column may take to be written into a statement. Paired
 * with "and the catalogue returned this name for this table" in `catalogueHas`
 * below, and belt to that braces: see the comment there.
 */
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/

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
 * Epoch milliseconds for an instant that arrived in one of the three shapes a
 * caller can produce - a Date from `pg`, an ISO string from this reader, or a
 * number from a test - or null when the value is absent or unreadable.
 *
 * This is deliberately NOT `readInstant`: the reader refuses a value it cannot
 * parse, because a real column holding junk is a fact it must not silently drop,
 * while the summaries run over rows a caller assembled and must survive one bad
 * timestamp by skipping it rather than throwing.
 * @param {unknown} value
 * @returns {number|null}
 */
function instantOf(value) {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Epoch milliseconds for the `now` the caller injected. A `now` this module
 * cannot read is a programming error rather than a queue state, so it is thrown
 * instead of defaulted: guessing at the clock would make every age unmeasurable
 * and every queue look clean, which is the exact failure this file exists to
 * prevent.
 * @param {Date|number} now
 * @returns {number}
 */
function requireNowMs(now) {
  const ms = instantOf(now)
  if (ms === null) {
    throw new Error(
      'the durable queue summaries need an instant to measure against, and the value they were ' +
        'given is not a Date, an ISO string or epoch milliseconds.',
    )
  }
  return ms
}

/**
 * A text value from an untrusted row, or null when it is absent. An empty string
 * is treated as absent: it is not something an operator can search by.
 * @param {unknown} value
 * @returns {string|null}
 */
function optionalText(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * A text column's value, or null when this schema has no such column or the row
 * holds SQL NULL. A value that IS there and is not text is refused rather than
 * coerced: `String(row.x)` would turn a driver surprise into a plausible-looking
 * report.
 * @param {unknown} raw
 * @param {boolean} present whether the catalogue says this column exists
 * @param {string} column
 * @param {string} subject what the message should name
 * @param {string} table
 * @returns {{ok: true, value: string|null} | {ok: false, problem: string}}
 */
function readText(raw, present, column, subject, table) {
  if (!present) return { ok: true, value: null }
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw === 'string') return { ok: true, value: raw }
  return { ok: false, problem: `${table} returned a ${column} for ${subject} that is not text.` }
}

/**
 * Something an operator can search by, in order of usefulness. Always a string,
 * so a printed row can never come out blank where an account should be.
 * @param {{email?: unknown, userId?: unknown, eventId?: unknown, id?: unknown}} row
 * @returns {string}
 */
function identityFor(row) {
  const candidates = [row.email, row.userId, row.eventId, row.id]
  for (const candidate of candidates) {
    const text = optionalText(candidate)
    if (text !== null) return text
  }
  return '(unidentified)'
}

/**
 * Plain-language age, because "900000 ms" is not a thing anyone reads.
 * Exported so a log line and a failure message can never disagree about how long
 * something has been broken.
 * @param {number} ms
 * @returns {string}
 */
export function formatAge(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/**
 * Event ids for a message, capped so a backlog cannot flood the log.
 * @param {Array<{eventId: string}>} events
 * @returns {string}
 */
function nameEvents(events) {
  const ids = events.map((event) => event.eventId)
  if (ids.length <= MAX_NAMED_EVENTS) return ids.join(', ')
  return `${ids.slice(0, MAX_NAMED_EVENTS).join(', ')} and ${ids.length - MAX_NAMED_EVENTS} more`
}

/**
 * Whether a name this module wrote is a name the catalogue returned for this
 * table.
 *
 * WHY THIS GUARD EXISTS. The SELECT lists below are built from the catalogue, so
 * a column name reaches a query string, and the catalogue is itself data that
 * came out of the database. A name is therefore only ever interpolated when it
 * matches the identifier pattern AND the catalogue listed it for that very
 * table; every other column becomes a literal NULL of the same name, which keeps
 * the row shape identical without trusting the input. This is the only place in
 * this module that puts a name it did not write into SQL.
 * @param {string} column
 * @param {string[]} columns
 * @returns {boolean}
 */
function catalogueHas(column, columns) {
  return IDENTIFIER_PATTERN.test(column) && columns.includes(column)
}

/**
 * A SELECT item for a text column: the column itself when this table has it,
 * NULL::text with the same name when it does not, so every row this reader
 * parses has the same fields whichever shape the table is in.
 * @param {string} column
 * @param {string[]} columns
 * @returns {string}
 */
function textSelectItem(column, columns) {
  return catalogueHas(column, columns) ? column : `NULL::text AS ${column}`
}

/**
 * The same, for a timestamptz. The instant is rendered in SQL so the reader never
 * has to guess whether the driver handed back a Date or a string.
 * @param {string} column
 * @param {string[]} columns
 * @returns {string}
 */
function instantSelectItem(column, columns) {
  if (!catalogueHas(column, columns)) return `NULL::text AS ${column}`
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${column}`
}

/**
 * The extended shape, and the only one in which a row can be unfinished at all.
 * NULLS FIRST puts the rows with no stamp at all in front of the ones that can be
 * aged.
 * @param {string[]} columns
 * @returns {string}
 */
function unfinishedEventsWithStampSql(columns) {
  return `
  SELECT event_id,
         last_error,
         to_char(last_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_attempt_at,
         ${textSelectItem('email', columns)},
         ${textSelectItem('user_id', columns)}
    FROM public.webhook_events
   WHERE processed_at IS NULL
   ORDER BY last_attempt_at NULLS FIRST, event_id
`
}

/**
 * The shape with no stamp columns: the rows exist, their age does not.
 * @param {string[]} columns
 * @returns {string}
 */
function unfinishedEventsWithoutStampSql(columns) {
  return `
  SELECT event_id,
         ${textSelectItem('email', columns)},
         ${textSelectItem('user_id', columns)}
    FROM public.webhook_events
   WHERE processed_at IS NULL
   ORDER BY event_id
`
}

/**
 * The operator's work queue, oldest first - the same rows and the same order as
 * records.ts's listUnresolvedFailures(), over a connection that exists here. The
 * columns beyond stage/attempts/first_seen_at are read only when the catalogue
 * says this database has them, because that list has changed before and this
 * query must not be the thing that breaks when it changes again.
 * @param {string[]} columns
 * @returns {string}
 */
function unresolvedFailuresSql(columns) {
  return `
  SELECT stage,
         attempts,
         to_char(first_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first_seen_at,
         ${textSelectItem('id', columns)},
         ${textSelectItem('email', columns)},
         ${textSelectItem('user_id', columns)},
         ${textSelectItem('event_id', columns)},
         ${textSelectItem('event_type', columns)},
         ${instantSelectItem('last_attempt_at', columns)}
    FROM public.billing_failures
   WHERE resolved_at IS NULL
   ORDER BY first_seen_at ASC, stage ASC
`
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
    await query(
      canAge ? unfinishedEventsWithStampSql(columns) : unfinishedEventsWithoutStampSql(columns),
    ),
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

    const email = readText(row.email, columns.includes('email'), 'email', eventId, WEBHOOK_EVENTS_TABLE)
    if (!email.ok) return { ok: false, problem: email.problem }
    const userId = readText(row.user_id, columns.includes('user_id'), 'user_id', eventId, WEBHOOK_EVENTS_TABLE)
    if (!userId.ok) return { ok: false, problem: userId.problem }

    events.push({ eventId, lastError, lastAttemptAt, email: email.value, userId: userId.value })
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

  const rows = asRows(await query(unresolvedFailuresSql(columns)))
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
    const lastAttempt = readInstant(row.last_attempt_at)
    if (!lastAttempt.ok) {
      return {
        ok: false,
        problem:
          `${BILLING_FAILURES_TABLE} returned an unreadable last_attempt_at for a ${stage} failure, ` +
          'so how long it has been since anyone tried cannot be worked out. Refusing to guess it.',
      }
    }

    const id = readText(row.id, columns.includes('id'), 'id', `a ${stage} failure`, BILLING_FAILURES_TABLE)
    if (!id.ok) return { ok: false, problem: id.problem }
    const email = readText(row.email, columns.includes('email'), 'email', `a ${stage} failure`, BILLING_FAILURES_TABLE)
    if (!email.ok) return { ok: false, problem: email.problem }
    const userId = readText(row.user_id, columns.includes('user_id'), 'user_id', `a ${stage} failure`, BILLING_FAILURES_TABLE)
    if (!userId.ok) return { ok: false, problem: userId.problem }
    const eventId = readText(row.event_id, columns.includes('event_id'), 'event_id', `a ${stage} failure`, BILLING_FAILURES_TABLE)
    if (!eventId.ok) return { ok: false, problem: eventId.problem }
    const eventType = readText(row.event_type, columns.includes('event_type'), 'event_type', `a ${stage} failure`, BILLING_FAILURES_TABLE)
    if (!eventType.ok) return { ok: false, problem: eventType.problem }

    failures.push({
      id: id.value,
      stage,
      identity: identityFor({
        email: email.value,
        userId: userId.value,
        eventId: eventId.value,
        id: id.value,
      }),
      email: email.value,
      userId: userId.value,
      eventId: eventId.value,
      eventType: eventType.value,
      attempts,
      firstSeenAt: seen.iso,
      lastAttemptAt: lastAttempt.iso,
    })
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
 * How long this unfinished event has been unfinished, or null when it is not
 * reported at all. Null means one of two things, and neither of them is "fine":
 * the row is still inside the window (Stripe may yet finish the job itself), or
 * the row carries no stamp and its age cannot be measured. One rule, one
 * comparison, used by both the summary that PRINTS these rows and the grader that
 * fails on them, so a row can never be printed without being graded, or graded
 * without being printed.
 * @param {EventRow} event
 * @param {number} nowMs
 * @param {number} thresholdMs
 * @returns {number|null}
 */
function stuckAgeMs(event, nowMs, thresholdMs) {
  const attemptedMs = instantOf(event.lastAttemptAt)
  // See STUCK_EVENT_NOTE: no timestamp is no measurement, so it is not reported
  // here rather than reported wrongly.
  if (attemptedMs === null) return null
  const ageMs = nowMs - attemptedMs
  // Strictly older: a row exactly at the threshold is not yet stuck.
  return ageMs > thresholdMs ? ageMs : null
}

/**
 * The unfinished events old enough to be worth an operator's attention.
 *
 * Pure: rows in, report out. The count is exact and only the PRINTED list is
 * bounded, because a truncated list that is read as the total is how a backlog of
 * 300 becomes a note about 20.
 * @param {EventRow[]} events
 * @param {Date|number} [now]
 * @param {number} [thresholdMs]
 * @param {number} [sampleLimit]
 * @returns {UnfinishedEventSummary}
 */
export function summarizeUnfinishedEvents(
  events,
  now = new Date(),
  thresholdMs = UNFINISHED_EVENT_THRESHOLD_MS,
  sampleLimit = SAMPLE_LIMIT,
) {
  const nowMs = requireNowMs(now)
  /** @type {StuckEvent[]} */
  const stuck = []

  for (const event of events) {
    const ageMs = stuckAgeMs(event, nowMs, thresholdMs)
    if (ageMs === null) continue
    // A Date, an ISO string and epoch milliseconds all reach this line, and the
    // report renders one shape so a log line does not change with the driver.
    const attemptedMs = instantOf(event.lastAttemptAt)
    stuck.push({
      eventId: event.eventId,
      lastAttemptAt: attemptedMs === null ? null : new Date(attemptedMs).toISOString(),
      lastError: event.lastError ?? null,
      email: optionalText(event.email),
      userId: optionalText(event.userId),
      ageMs,
    })
  }

  // Oldest first: the longest-abandoned event is the one most likely to be lost,
  // and it is the one an operator should read first in a bounded sample.
  stuck.sort((left, right) => right.ageMs - left.ageMs)

  return {
    count: stuck.length,
    thresholdMs,
    oldestAgeMs: stuck.length > 0 ? stuck[0].ageMs : null,
    sample: stuck.slice(0, sampleLimit),
  }
}

/**
 * The unresolved failures, oldest first, with the axes an operator needs kept
 * apart: `ageMs` is how long the row has been OPEN (measured from firstSeenAt,
 * the same axis the ordering uses), and `sinceLastAttemptMs` is how long since
 * anyone tried. Neither number may be read as the other.
 *
 * Pure, and it also skips a resolved row: the query already filters those out,
 * and this function's count has to mean "unresolved" without trusting its caller.
 * @param {FailureRow[]} failures
 * @param {Date|number} [now]
 * @param {number} [sampleLimit]
 * @returns {UnresolvedFailureSummary}
 */
export function summarizeUnresolvedFailures(failures, now = new Date(), sampleLimit = SAMPLE_LIMIT) {
  const nowMs = requireNowMs(now)
  /** @type {SummarizedFailure[]} */
  const open = []
  /** @type {Map<string, number>} */
  const tally = new Map()

  for (const failure of failures) {
    if (failure.resolvedAt) continue

    const firstSeenMs = instantOf(failure.firstSeenAt)
    const lastAttemptMs = instantOf(failure.lastAttemptAt)
    const stage = optionalText(failure.stage) ?? '(no stage)'
    tally.set(stage, (tally.get(stage) ?? 0) + 1)

    open.push({
      id: optionalText(failure.id),
      stage,
      // Derived here rather than read from the row's `identity` field: the
      // summary must be able to describe a row a caller assembled, and a field
      // that can be set to anything must not be able to disagree with the fields
      // the row actually carries. Both this and the reader call identityFor, so a
      // printed identity and a stored one cannot diverge.
      identity: identityFor(failure),
      email: optionalText(failure.email),
      userId: optionalText(failure.userId),
      eventId: optionalText(failure.eventId),
      eventType: optionalText(failure.eventType),
      attempts: typeof failure.attempts === 'number' ? failure.attempts : null,
      firstSeenAt: firstSeenMs === null ? null : new Date(firstSeenMs).toISOString(),
      lastAttemptAt: lastAttemptMs === null ? null : new Date(lastAttemptMs).toISOString(),
      ageMs: firstSeenMs === null ? null : nowMs - firstSeenMs,
      sinceLastAttemptMs: lastAttemptMs === null ? null : nowMs - lastAttemptMs,
    })
  }

  open.sort((left, right) => (instantOf(left.firstSeenAt) ?? 0) - (instantOf(right.firstSeenAt) ?? 0))

  return {
    count: open.length,
    // Pairs rather than an object: the stage value comes from the database, and a
    // computed key on a record is both a lint error and a lost index signature.
    /** @type {Array<[string, number]>} */
    byStage: [...tally.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
    oldestAgeMs: open.length > 0 ? open[0].ageMs : null,
    sample: open.slice(0, sampleLimit),
  }
}

/**
 * Why the events in hand carry no timestamp that can be measured - and the two
 * answers are NOT the same problem.
 *
 * A schema with no `last_attempt_at` column cannot age ANY row of the table and
 * is fixed by finishing the migration. A schema that HAS the column and a row
 * with NULL in it is a claim whose handler recorded no attempt before it
 * stopped, and no migration brings that stamp back: the column is already there.
 * Reporting the first case's fix for the second case would send an operator
 * looking for a deploy that is not missing.
 * @param {EventRow[]} events
 * @param {boolean} canAgeEvents whether this schema carries the stamp column
 * @returns {string}
 */
function unageableWarning(events, canAgeEvents) {
  const why = canAgeEvents
    ? `This schema CAN stamp an attempt and these rows carry none, so this is a claim whose handler ` +
      'recorded no attempt at all before it stopped - a killed process, or a failure write that ' +
      'never landed. No migration adds that stamp back.'
    : `This schema has no last_attempt_at column, so no row of ${WEBHOOK_EVENTS_TABLE} can be aged ` +
      'until the rest of the webhook_events migration is applied.'
  return (
    `${events.length} webhook event(s) are unfinished and this reader has no attempt timestamp to ` +
    `age them against (${nameEvents(events)}). ${why} They are older than they look and younger ` +
    'than they look, and this run can say neither, so treat it as INCOMPLETE rather than clean.'
  )
}

/**
 * Turn a reading into the reasons this run must go red, and the things it must
 * say loudly without failing.
 *
 * The decision NOT to fail on an absent table lives here, with its reasoning: the
 * run is not clean (`complete` is false, and the warnings say so), but a missing
 * migration is not a billing incident and reddening the schedule for it would
 * make the alert mean two different things.
 *
 * @param {DurableQueueReading} reading
 * @param {Date} [now]
 * @returns {DurableQueueVerdict}
 */
export function gradeDurableQueues(reading, now = new Date()) {
  const nowMs = requireNowMs(now)
  /** @type {string[]} */
  const failures = []
  /** @type {string[]} */
  const warnings = []

  // What could not be read comes first, then what was read and is wrong.
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

  // Rows that exist but cannot be aged: the half-applied-migration shape, or a
  // claim whose handler died before it recorded an attempt. They cannot be called
  // stuck (there is no measurement to compare against the limit) and must not be
  // called fine, which leaves reporting them as the incomplete answer they are.
  const unageable = reading.unfinishedEvents.filter((event) => event.lastAttemptAt === null)
  if (unageable.length > 0) warnings.push(unageableWarning(unageable, reading.canAgeEvents))

  for (const event of reading.unfinishedEvents) {
    const ageMs = stuckAgeMs(event, nowMs, UNFINISHED_EVENT_THRESHOLD_MS)
    if (ageMs === null) continue
    failures.push(
      `webhook event ${event.eventId} has been unfinished for ${formatAge(ageMs)}, past the ` +
        `${formatAge(UNFINISHED_EVENT_THRESHOLD_MS)} limit (last attempt: ${event.lastAttemptAt}). ` +
        `last_error: ${event.lastError ?? '(none recorded - the handler did not get as far as writing one)'}`,
    )
  }

  // One line for the whole queue, not one per row: an operator needs the size and
  // the shape of the backlog first, and the sample below it is what the runner
  // prints. The pairs carry the most frequent stage first for the same reason.
  const open = summarizeUnresolvedFailures(reading.unresolvedFailures, now)
  if (open.count > 0) {
    const stages = open.byStage.map(([stage, count]) => `${stage}=${count}`).join(', ')
    const oldest = open.oldestAgeMs === null ? null : formatAge(open.oldestAgeMs)
    failures.push(
      `${BILLING_FAILURES_TABLE} holds ${open.count} unresolved failure(s) (stages: ${stages}` +
        `${oldest === null ? '' : `, oldest ${oldest}`}). Stripe retrying the event will not clear ` +
        'these - they need a person - and nothing here resolves them on its own.',
    )
  }

  return { ok: failures.length === 0, complete: warnings.length === 0, failures, warnings }
}
