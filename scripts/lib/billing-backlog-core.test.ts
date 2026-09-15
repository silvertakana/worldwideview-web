import { describe, it, expect } from 'vitest'
import {
  SAMPLE_LIMIT,
  STUCK_EVENT_THRESHOLD_MS,
  selectStuckEvents,
  summarizeFailures,
} from './billing-backlog-core.mjs'

/**
 * The two detectors that make the billing launch's durable queues visible. They
 * are pure, so everything here is a fixture: no database, no clock.
 *
 * The cases that matter most are the ones that decide NOT to report: a
 * threshold that is off by a comparison operator, or a NULL timestamp treated as
 * "ancient", turns a nightly alert into noise nobody reads.
 */

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-09-15T12:00:00.000Z')
/** An ISO timestamp `msAgo` before NOW. */
const ago = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const event = (over: Record<string, unknown> = {}) => ({
  event_id: 'evt_1',
  last_attempt_at: ago(3 * HOUR),
  last_error: 'handler threw',
  ...over,
})

const failure = (over: Record<string, unknown> = {}) => ({
  id: 'fail-1',
  user_id: 'user-1',
  email: 'broken@example.com',
  event_id: 'evt_1',
  event_type: 'checkout.session.completed',
  stage: 'provision',
  error: 'globe returned 500',
  attempts: 3,
  first_seen_at: ago(48 * HOUR),
  last_attempt_at: ago(47 * HOUR),
  resolved_at: null,
  ...over,
})

describe('selectStuckEvents', () => {
  it('reports nothing for an empty queue', () => {
    expect(selectStuckEvents({ events: [], now: NOW })).toEqual({
      count: 0,
      thresholdMs: STUCK_EVENT_THRESHOLD_MS,
      oldestAgeMs: null,
      sample: [],
    })
  })

  it('reports an event that has made no progress for hours', () => {
    const result = selectStuckEvents({ events: [event()], now: NOW })

    expect(result.count).toBe(1)
    expect(result.oldestAgeMs).toBe(3 * HOUR)
    expect(result.sample[0]).toEqual({
      eventId: 'evt_1',
      lastAttemptAt: ago(3 * HOUR),
      lastError: 'handler threw',
      ageMs: 3 * HOUR,
    })
  })

  it('does not report an event exactly at the threshold', () => {
    const result = selectStuckEvents({
      events: [event({ last_attempt_at: ago(STUCK_EVENT_THRESHOLD_MS) })],
      now: NOW,
    })
    expect(result.count).toBe(0)
  })

  it('reports an event one millisecond past the threshold', () => {
    const result = selectStuckEvents({
      events: [event({ last_attempt_at: ago(STUCK_EVENT_THRESHOLD_MS + 1) })],
      now: NOW,
    })
    expect(result.count).toBe(1)
  })

  it('leaves a still-recent failure alone, since Stripe is probably retrying it', () => {
    const result = selectStuckEvents({
      events: [event({ last_attempt_at: ago(5 * 60 * 1000) })],
      now: NOW,
    })
    expect(result.count).toBe(0)
  })

  it('skips rows with no attempt timestamp rather than guessing at their age', () => {
    // Documented blind spot: claimed-but-never-failed rows cannot be told apart
    // from one claimed a second ago, because the ledger has no claim timestamp.
    const result = selectStuckEvents({
      events: [event({ last_attempt_at: null }), event({ last_attempt_at: undefined })],
      now: NOW,
    })
    expect(result.count).toBe(0)
  })

  it('skips an unparseable timestamp instead of treating it as ancient', () => {
    expect(selectStuckEvents({ events: [event({ last_attempt_at: 'not a date' })], now: NOW }).count).toBe(0)
  })

  it('accepts a Date, an ISO string, or epoch milliseconds', () => {
    const asDate = selectStuckEvents({ events: [event({ last_attempt_at: new Date(NOW - 3 * HOUR) })], now: NOW })
    const asIso = selectStuckEvents({ events: [event({ last_attempt_at: ago(3 * HOUR) })], now: NOW })
    const asMillis = selectStuckEvents({ events: [event({ last_attempt_at: NOW - 3 * HOUR })], now: NOW })

    expect(asDate.count).toBe(1)
    expect(asIso.count).toBe(1)
    expect(asMillis.count).toBe(1)
  })

  it('keeps the count exact while bounding the sample, oldest first', () => {
    // Ages run 2h .. 26h, so every fixture is past the 1h threshold.
    const events = Array.from({ length: SAMPLE_LIMIT + 5 }, (_, index) =>
      event({ event_id: `evt_${index}`, last_attempt_at: ago((index + 2) * HOUR) }),
    )

    const result = selectStuckEvents({ events, now: NOW })

    expect(result.count).toBe(SAMPLE_LIMIT + 5)
    expect(result.sample).toHaveLength(SAMPLE_LIMIT)
    // index 0 is the most recent of the batch, so the oldest is the last one.
    expect(result.sample[0].eventId).toBe(`evt_${SAMPLE_LIMIT + 4}`)
    expect(result.sample[0].ageMs).toBe(26 * HOUR)
    expect(result.oldestAgeMs).toBe(26 * HOUR)
  })

  it('honours a custom threshold', () => {
    const events = [event({ last_attempt_at: ago(2 * HOUR) })]
    expect(selectStuckEvents({ events, now: NOW, thresholdMs: HOUR }).count).toBe(1)
    expect(selectStuckEvents({ events, now: NOW, thresholdMs: 5 * HOUR }).count).toBe(0)
  })
})

describe('summarizeFailures', () => {
  it('reports nothing for an empty queue', () => {
    expect(summarizeFailures({ failures: [], now: NOW })).toEqual({
      count: 0,
      byStage: [],
      oldestAgeMs: null,
      sample: [],
    })
  })

  it('reports an unresolved failure with its stage and identity', () => {
    const result = summarizeFailures({ failures: [failure()], now: NOW })

    expect(result.count).toBe(1)
    expect(result.sample[0]).toMatchObject({
      stage: 'provision',
      identity: 'broken@example.com',
      email: 'broken@example.com',
      eventId: 'evt_1',
      eventType: 'checkout.session.completed',
      attempts: 3,
      // ageMs is time OPEN (48h since first_seen), not time since the last try.
      ageMs: 48 * HOUR,
      sinceLastAttemptMs: 47 * HOUR,
    })
  })

  it('never reports a resolved failure, even if the caller passes one', () => {
    const result = summarizeFailures({
      failures: [failure(), failure({ id: 'fail-2', resolved_at: ago(HOUR) })],
      now: NOW,
    })
    expect(result.count).toBe(1)
    expect(result.sample[0].id).toBe('fail-1')
  })

  it('falls back through email, user id, event id, then row id', () => {
    const identity = (over: Record<string, unknown>) =>
      summarizeFailures({ failures: [failure(over)], now: NOW }).sample[0].identity

    expect(identity({ email: 'a@example.com' })).toBe('a@example.com')
    expect(identity({ email: null })).toBe('user-1')
    expect(identity({ email: null, user_id: null })).toBe('evt_1')
    expect(identity({ email: null, user_id: null, event_id: null })).toBe('fail-1')
    expect(identity({ email: null, user_id: null, event_id: null, id: null })).toBe('(unidentified)')
  })

  it('tallies by stage, most frequent first', () => {
    const result = summarizeFailures({
      failures: [
        failure({ id: 'a', stage: 'provision' }),
        failure({ id: 'b', stage: 'tier_sync' }),
        failure({ id: 'c', stage: 'provision' }),
      ],
      now: NOW,
    })

    expect(result.count).toBe(3)
    expect(result.byStage).toEqual([
      ['provision', 2],
      ['tier_sync', 1],
    ])
  })

  it('orders the sample oldest first, whichever order the rows arrived in', () => {
    const result = summarizeFailures({
      failures: [
        failure({ id: 'newer', first_seen_at: ago(2 * HOUR) }),
        failure({ id: 'oldest', first_seen_at: ago(72 * HOUR) }),
        failure({ id: 'middle', first_seen_at: ago(24 * HOUR) }),
      ],
      now: NOW,
    })

    expect(result.sample.map((item) => item.id)).toEqual(['oldest', 'middle', 'newer'])
    // The longest-broken failure is the one costing a customer the most.
    expect(result.oldestAgeMs).toBe(72 * HOUR)
  })

  it('keeps the count exact while bounding the sample', () => {
    const failures = Array.from({ length: SAMPLE_LIMIT + 4 }, (_, index) =>
      failure({ id: `fail_${index}`, first_seen_at: ago((index + 1) * HOUR) }),
    )

    const result = summarizeFailures({ failures, now: NOW })

    expect(result.count).toBe(SAMPLE_LIMIT + 4)
    expect(result.sample).toHaveLength(SAMPLE_LIMIT)
  })

  it('survives a row missing the fields it reports on', () => {
    const result = summarizeFailures({
      failures: [failure({ stage: null, attempts: null, first_seen_at: null, last_attempt_at: null })],
      now: NOW,
    })

    expect(result.count).toBe(1)
    expect(result.sample[0].stage).toBe('(no stage)')
    expect(result.sample[0].attempts).toBeNull()
    expect(result.sample[0].ageMs).toBeNull()
    expect(result.sample[0].sinceLastAttemptMs).toBeNull()
    expect(result.byStage).toEqual([['(no stage)', 1]])
  })
})
