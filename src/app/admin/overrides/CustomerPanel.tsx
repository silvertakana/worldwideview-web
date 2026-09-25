'use client'

import type { OperatorCustomer } from '@/lib/billing/customer-lookup'
import type { BillingOverride } from '@/lib/billing/billing-tables'
import type { GlobeReadResult } from '@/lib/billing/globe-tiers'
import { GrantForm } from './GrantForm'
import styles from './overrides.module.css'

interface Props {
  customer: OperatorCustomer
  globe: GlobeReadResult
  pending: boolean
  retryTier: string | null
  onGrant: (tier: string, reason: string) => void
  onRevoke: () => void
  onRetry: () => void
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '-'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString()
}

function actorFor(customer: OperatorCustomer, actorId: string | null | undefined): string {
  if (!actorId) return 'unknown'
  return customer.actors[actorId] ?? actorId
}

/** Owner of the durable record is the single most important thing on this screen. */
function LedgerSource({ source }: { source: string | null | undefined }) {
  if (source === 'manual') {
    return <span className={`${styles.badge} ${styles.badgeManual}`}>Operator-owned</span>
  }
  if (source === 'stripe') {
    return <span className={`${styles.badge} ${styles.badgeStripe}`}>Stripe-owned</span>
  }
  return <span className={`${styles.badge} ${styles.badgeNone}`}>Unknown owner</span>
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.key}>{label}</span>
      <span className={styles.value}>{children}</span>
    </div>
  )
}

function OverrideHistoryRow({ row, customer }: { row: BillingOverride; customer: OperatorCustomer }) {
  const revoked = row.revoked_at !== null
  return (
    <tr>
      <td>{formatDate(row.created_at)}</td>
      <td className={styles.mono}>{row.tier}</td>
      <td>{actorFor(customer, row.created_by)}</td>
      <td>{row.reason}</td>
      <td>
        {revoked
          ? `revoked ${formatDate(row.revoked_at)} by ${actorFor(customer, row.revoked_by)}`
          : 'active'}
      </td>
    </tr>
  )
}

export function CustomerPanel({ customer, globe, pending, retryTier, onGrant, onRevoke, onRetry }: Props) {
  const { subscription, override, history, entitlements } = customer

  /**
   * A grant whose globe push failed leaves the hub and the globe disagreeing
   * about the same customer. Deriving that from the two records - rather than
   * only from this session's last action - means the retry is still offered to
   * whoever opens the screen tomorrow.
   */
  const globeDisagrees = override !== null && globe.ok && globe.state.tier !== override.tier
  const outstandingTier = override && globeDisagrees ? override.tier : null

  return (
    <div className={styles.stack}>
      <section className={styles.card}>
        <h3 className={styles.cardHeading}>Customer</h3>
        <Row label="Email">{customer.email}</Row>
        <Row label="Hub user id">
          <code className={styles.mono}>{customer.userId}</code>
        </Row>
        <Row label="Signed up">{formatDate(customer.createdAt)}</Row>
      </section>

      <section className={styles.card}>
        <h3 className={styles.cardHeading}>
          Durable billing record <LedgerSource source={subscription?.source} />
        </h3>
        {subscription ? (
          <>
            <Row label="Plan / status">
              {subscription.plan ?? 'unknown'} / {subscription.status}
            </Row>
            <Row label="Stripe subscription">
              {subscription.stripe_subscription_id ? (
                <code className={styles.mono}>{subscription.stripe_subscription_id}</code>
              ) : (
                'none - this row was not created by Stripe'
              )}
            </Row>
            <Row label="Current period ends">{formatDate(subscription.current_period_end)}</Row>
            <Row label="Trial ends">{formatDate(subscription.trial_ends_at)}</Row>
          </>
        ) : (
          <p className={styles.warning}>
            NO durable record. The hub has no subscription on file for this customer, so if they have
            access it is coming from an operator override or a legacy access code - not from a payment.
          </p>
        )}
      </section>

      <section className={styles.card}>
        <h3 className={styles.cardHeading}>Operator override</h3>
        {override ? (
          <>
            <Row label="Tier">{override.tier}</Row>
            <Row label="Reason">{override.reason}</Row>
            <Row label="Granted">
              {formatDate(override.created_at)} by {actorFor(customer, override.created_by)}
            </Row>
          </>
        ) : (
          <p className={styles.hint}>No active override.</p>
        )}
      </section>

      <section className={styles.card}>
        <h3 className={styles.cardHeading}>Globe (what the customer actually feels)</h3>
        {globe.ok ? (
          <>
            <Row label="Tier / status">
              {globe.state.tier} / {globe.state.status}
            </Row>
            <Row label="Effective">
              {globe.state.effectiveTier} / {globe.state.effectiveStatus}
            </Row>
            <Row label="Globe workspaces owned">{globe.state.instanceCount}</Row>
          </>
        ) : (
          <p className={styles.warning}>{globe.detail}</p>
        )}
      </section>

      <section className={styles.card}>
        <h3 className={styles.cardHeading}>Legacy code access</h3>
        <p className={styles.hint}>
          Access codes are retired: a paid subscription or an operator override is the normal path.
          These rows exist only to keep an account that redeemed a code working.
        </p>
        {entitlements.length > 0 ? (
          <ul className={styles.list}>
            {entitlements.map((entitlement) => (
              <li key={entitlement.id} className={styles.listItem}>
                <span className={styles.mono}>{entitlement.tier}</span> ({entitlement.grants_days} days)
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.hint}>None.</p>
        )}
      </section>

      <section className={styles.card}>
        <h3 className={styles.cardHeading}>Audit trail</h3>
        {history.length > 0 ? (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Granted</th>
                <th>Tier</th>
                <th>By</th>
                <th>Why</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <OverrideHistoryRow key={row.id} row={row} customer={customer} />
              ))}
            </tbody>
          </table>
        ) : (
          <p className={styles.hint}>Nothing has ever been granted to this customer by hand.</p>
        )}
      </section>

      <GrantForm
        activeTier={override?.tier ?? null}
        hasOverride={override !== null}
        pending={pending}
        retryTier={retryTier ?? outstandingTier}
        onGrant={onGrant}
        onRevoke={onRevoke}
        onRetry={onRetry}
      />
    </div>
  )
}
