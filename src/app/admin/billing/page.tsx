import { requireAdmin } from '@/lib/auth/admin'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isBillingPaused, type KillSwitchSource } from '@/lib/billing/kill-switch'
import { KillSwitchForm } from './KillSwitchForm'
import {
  AuditTrail,
  ControlRowPanel,
  type BillingControlEvent,
  type BillingControlRow,
} from './BillingControlPanels'
import styles from './BillingControl.module.css'

export const metadata = { title: 'Billing Control | Admin' }

const SOURCE_LABEL: Record<KillSwitchSource, string> = {
  env: 'BILLING_KILL_SWITCH environment variable',
  database: 'billing_control database row',
  unavailable: 'unreadable (database unreachable)',
}

function isEnvOverrideSet(): boolean {
  const raw = process.env.BILLING_KILL_SWITCH?.trim().toLowerCase()
  return raw === 'true' || raw === '1' || raw === 'yes'
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error'
}

export default async function AdminBillingPage() {
  await requireAdmin()

  const effective = await isBillingPaused()
  const envOverride = isEnvOverrideSet()

  const supabase = await createClient()
  const { data: controlRow, error: rowError } = await supabase
    .from('billing_control')
    .select('id, billing_paused, reason, paused_by, created_at, updated_at')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  // billing_control_events is service_role only: the authenticated client the
  // SELECT policy was written for cannot read the audit trail. A missing
  // service-role key throws here and a missing table answers with an error;
  // neither may take down the page that reports whether billing is stopped.
  let trail: BillingControlEvent[] = []
  let auditError: string | null = null
  try {
    const admin = createAdminClient()
    const { data: events, error } = await admin
      .from('billing_control_events')
      .select('action, reason, actor_user_id, created_at')
      .order('created_at', { ascending: false })
      .limit(10)
    trail = (events ?? []) as BillingControlEvent[]
    auditError = error ? error.message : null
  } catch (err) {
    auditError = describeError(err)
  }

  const row = (controlRow ?? null) as BillingControlRow | null

  return (
    <div>
      <h2 className={styles.heading}>Billing Control</h2>

      {envOverride && (
        <div className={styles.bannerCritical} role="alert">
          <h3 className={styles.bannerHeading}>
            BILLING_KILL_SWITCH is set: billing is forced OFF
          </h3>
          <p className={styles.bannerText}>
            The BILLING_KILL_SWITCH environment variable overrides everything below. While it is
            set, the database flag is NOT authoritative and flipping it to resume changes nothing.
            Clearing it takes an environment change plus a restart of the app.
          </p>
        </div>
      )}

      {effective.source === 'unavailable' && (
        <div className={styles.bannerWarning} role="alert">
          <h3 className={styles.bannerHeading}>Database unreachable: billing is failing CLOSED</h3>
          <p className={styles.bannerText}>
            The control row could not be read, so purchases are stopped by design rather than left
            open. New purchases are refused until the database answers again.
          </p>
        </div>
      )}

      <section className={styles.panel} aria-labelledby="effective-heading">
        <h3 id="effective-heading" className={styles.panelHeading}>
          Effective state
        </h3>
        <dl className={styles.statusList}>
          <div className={styles.statusItem}>
            <dt className={styles.statusLabel}>New purchases</dt>
            <dd className={effective.paused ? styles.statusPaused : styles.statusLive}>
              {effective.paused ? 'STOPPED' : 'ALLOWED'}
            </dd>
          </div>
          <div className={styles.statusItem}>
            <dt className={styles.statusLabel}>Decided by</dt>
            <dd className={styles.statusValue}>{SOURCE_LABEL[effective.source]}</dd>
          </div>
          <div className={styles.statusItem}>
            <dt className={styles.statusLabel}>Reason</dt>
            <dd className={styles.statusValue}>{effective.reason ?? 'none given'}</dd>
          </div>
        </dl>
      </section>

      <KillSwitchForm
        currentPaused={row?.billing_paused ?? effective.paused}
        currentReason={row?.reason ?? null}
      />

      <ControlRowPanel row={row} readError={rowError ? rowError.message : null} />
      <AuditTrail events={trail} readError={auditError} />
    </div>
  )
}
