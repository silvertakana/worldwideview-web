import styles from './BillingControl.module.css'

export interface BillingControlRow {
  id: string
  billing_paused: boolean
  reason: string | null
  paused_by: string | null
  created_at: string
  updated_at: string
}

export interface BillingControlEvent {
  action: string
  reason: string | null
  actor_user_id: string | null
  created_at: string
}

function formatStamp(value: string | null | undefined): string {
  if (!value) return 'unknown'
  return `${new Date(value).toISOString().replace('T', ' ').slice(0, 19)} UTC`
}

/** The stored flag, shown apart from the effective state: while the env override
 *  is set the two disagree, and the operator needs to see that. */
export function ControlRowPanel({
  row,
  readError,
}: {
  row: BillingControlRow | null
  readError?: string | null
}) {
  return (
    <section className={styles.panel} aria-labelledby="control-row-heading">
      <h3 id="control-row-heading" className={styles.panelHeading}>
        Stored control row (billing_control)
      </h3>
      {row ? (
        <dl className={styles.statusList}>
          <div className={styles.statusItem}>
            <dt className={styles.statusLabel}>Database flag</dt>
            <dd className={row.billing_paused ? styles.statusPaused : styles.statusLive}>
              billing_paused = {String(row.billing_paused)}
            </dd>
          </div>
          <div className={styles.statusItem}>
            <dt className={styles.statusLabel}>Reason on file</dt>
            <dd className={styles.statusValue}>{row.reason ?? 'none given'}</dd>
          </div>
          <div className={styles.statusItem}>
            <dt className={styles.statusLabel}>Set by</dt>
            <dd className={styles.statusValue}>{row.paused_by ?? 'unknown'}</dd>
          </div>
          <div className={styles.statusItem}>
            <dt className={styles.statusLabel}>Last change</dt>
            <dd className={styles.statusValue}>{formatStamp(row.updated_at)}</dd>
          </div>
        </dl>
      ) : (
        <p className={styles.empty}>
          {readError
            ? `The control row could not be read (${readError}). The switch above reports itself unavailable, so billing fails CLOSED: new purchases stay stopped.`
            : 'No billing_control row exists, so the kill switch migration has not run against this database. Until it does, the switch reports itself unavailable and billing fails CLOSED: new purchases stay stopped.'}
        </p>
      )}
    </section>
  )
}

export function AuditTrail({
  events,
  readError,
}: {
  events: BillingControlEvent[]
  readError?: string | null
}) {
  return (
    <section className={styles.panel} aria-labelledby="audit-heading">
      <h3 id="audit-heading" className={styles.panelHeading}>
        Recent pause and resume activity
      </h3>
      {readError ? (
        <p className={styles.empty}>
          The audit trail could not be read ({readError}). The event log is service-role only, so it
          is unreadable if the migration has not run or the service key is missing. The switch state
          above is unaffected.
        </p>
      ) : events.length === 0 ? (
        <p className={styles.empty}>No pause or resume events recorded yet.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Action</th>
                <th scope="col">When</th>
                <th scope="col">Actor</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event, index) => (
                <tr key={`${event.created_at}-${index}`}>
                  <td className={styles.actionCell}>{event.action}</td>
                  <td>{formatStamp(event.created_at)}</td>
                  <td className={styles.mono}>{event.actor_user_id ?? 'unknown'}</td>
                  <td>{event.reason ?? 'none given'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
