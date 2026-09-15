'use client'

import { useState } from 'react'
import { GLOBE_TIERS } from '@/lib/billing/globe-tiers'
import styles from './overrides.module.css'

interface Props {
  activeTier: string | null
  hasOverride: boolean
  pending: boolean
  retryTier: string | null
  onGrant: (tier: string, reason: string) => void
  onRevoke: () => void
  onRetry: () => void
}

function label(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1)
}

export function GrantForm({ activeTier, hasOverride, pending, retryTier, onGrant, onRevoke, onRetry }: Props) {
  const [tier, setTier] = useState<string>('pro')
  const [reason, setReason] = useState('')
  const trimmedReason = reason.trim()

  return (
    <section className={styles.card}>
      <h3 className={styles.cardHeading}>Grant or change access</h3>

      <div className={styles.field}>
        <label htmlFor="grant-tier" className={styles.label}>
          Tier
        </label>
        <select
          id="grant-tier"
          className={styles.select}
          value={tier}
          onChange={(event) => setTier(event.target.value)}
          disabled={pending}
        >
          {GLOBE_TIERS.map((option) => (
            <option key={option} value={option}>
              {label(option)}
            </option>
          ))}
        </select>
        <p className={styles.hint}>
          These are the only tiers the globe can represent. Beta Tester and Early Access exist on the
          hub but the globe rejects them outright, so they are not offered here.
        </p>
      </div>

      <div className={styles.field}>
        <label htmlFor="grant-reason" className={styles.label}>
          Reason (required)
        </label>
        <textarea
          id="grant-reason"
          className={styles.textarea}
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={pending}
          placeholder="e.g. Paid on 12 Sep, webhook failed, workspace locked. Ticket #4821."
        />
        <p className={styles.hint}>
          Write why this customer should have this tier. Six months from now this sentence is the
          only explanation anyone will have.
        </p>
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.button}
          disabled={pending || trimmedReason.length === 0}
          onClick={() => onGrant(tier, trimmedReason)}
        >
          {hasOverride ? 'Replace override' : 'Grant override'}
        </button>
        {hasOverride && (
          <button type="button" className={styles.buttonDanger} disabled={pending} onClick={onRevoke}>
            Revoke override{activeTier ? ` (${activeTier})` : ''}
          </button>
        )}
        {retryTier && (
          <button type="button" className={styles.buttonSecondary} disabled={pending} onClick={onRetry}>
            Retry the globe push ({retryTier})
          </button>
        )}
      </div>

      {trimmedReason.length === 0 && (
        <p className={styles.hint}>The grant button stays disabled until a reason is written.</p>
      )}
    </section>
  )
}
