import { requireAdmin } from '@/lib/auth/admin'
import { listUnresolvedFailures } from '@/lib/billing/records'
import type { BillingFailure } from '@/lib/billing/billing-tables'
import { describeAge, nowMs, stageLabel } from './format-age'
import { FailuresQueue } from './FailuresQueue'
import styles from './FailuresQueue.module.css'

export const metadata = { title: 'Billing failures | Admin' }

/** One row, already flattened to strings so the client cannot read a clock. */
export interface FailureRow {
  id: string
  age: string
  firstSeen: string
  lastAttempt: string
  stageLabel: string
  email: string
  userId: string
  error: string
  eventId: string
  eventType: string
  attempts: number
}

function toRow(failure: BillingFailure, now: number): FailureRow {
  return {
    id: failure.id,
    age: describeAge(failure.first_seen_at, now),
    firstSeen: failure.first_seen_at ? new Date(failure.first_seen_at).toLocaleString() : 'not recorded',
    lastAttempt: failure.last_attempt_at ? new Date(failure.last_attempt_at).toLocaleString() : 'never retried',
    stageLabel: stageLabel(failure.stage),
    email: failure.email ?? '',
    userId: failure.user_id ?? '',
    error: failure.error ?? 'no error text was recorded',
    eventId: failure.event_id ?? '',
    eventType: failure.event_type ?? 'unknown',
    attempts: failure.attempts,
  }
}

/**
 * The operator's work queue.
 *
 * billing_failures is where a customer-facing step that failed invisibly ends up:
 * the hub's half of a two-write grant landed and the globe's did not, so the
 * customer holds access nothing is granting them. The table existed and
 * listUnresolvedFailures() existed, but until this page no screen rendered it -
 * the only reader was retryManualOverridePush looking up its own row, so a
 * failure stayed invisible until the nightly reconcile run went red.
 */
export default async function AdminFailuresPage() {
  await requireAdmin()

  // Degrades to a message rather than throwing, the same shape /admin/billing
  // uses: an admin screen that cannot read its own queue should say so. The
  // alerting path for this queue is the reconcile run, not this page.
  let failures: BillingFailure[] = []
  let readError = ''
  try {
    failures = await listUnresolvedFailures()
  } catch (err) {
    readError = err instanceof Error ? err.message : String(err)
  }

  const now = nowMs()
  const rows = failures.map((failure) => toRow(failure, now))

  return (
    <div className={styles.page}>
      <h2 className={styles.heading}>Billing failures</h2>
      <p className={styles.intro}>
        Every step that failed after the hub had already recorded a decision, oldest first. A row
        here means a customer paid and did not get what they bought.
      </p>
      <p className={styles.intro}>
        Marking a row handled closes it and nothing more: it does not retry the step. A globe tier
        sync is re-pushed from the <strong>Billing overrides</strong> screen, by looking the
        customer up and retrying there. The customer is named by email and hub user id, and both
        are accepted by that screen&apos;s lookup.
      </p>

      {readError ? (
        <p className={styles.bannerError}>
          The queue could not be read, so this screen is showing nothing rather than showing it as
          empty: {readError}
        </p>
      ) : (
        <>
          <p className={styles.count}>
            {rows.length === 0
              ? 'No unresolved failures.'
              : `${rows.length} unresolved failure${rows.length === 1 ? '' : 's'}.`}
          </p>
          <FailuresQueue failures={rows} />
        </>
      )}
    </div>
  )
}
