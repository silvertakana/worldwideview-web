'use client'

import { useState } from 'react'
import { setBillingPaused } from './actions'
import styles from './KillSwitchForm.module.css'

interface KillSwitchFormProps {
  currentPaused: boolean
  currentReason?: string | null
}

export function KillSwitchForm({ currentPaused, currentReason }: KillSwitchFormProps) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [pending, setPending] = useState(false)

  async function handleSubmit(formData: FormData) {
    setPending(true)
    setError('')
    setConfirmation('')

    const submitted = String(formData.get('reason') ?? '')
    const result = await setBillingPaused(!currentPaused, submitted)

    if (result.success) {
      setConfirmation(currentPaused ? 'Billing resumed.' : 'Billing paused.')
      setReason('')
    } else {
      setError(result.error ?? 'The change could not be saved.')
    }
    setPending(false)
  }

  const actionLabel = currentPaused ? 'Resume billing' : 'Pause billing'

  return (
    <section className={styles.container} aria-labelledby="kill-switch-form-heading">
      <h3 id="kill-switch-form-heading" className={styles.heading}>
        {actionLabel}
      </h3>
      <p className={styles.hint}>
        The change is stored in the database and reaches every worker within 10 seconds.
        {currentPaused
          ? ' Resuming lets new customers buy again.'
          : ' Pausing stops new purchases immediately; existing subscriptions are untouched.'}
      </p>
      {currentReason && (
        <p className={styles.currentReason}>Reason currently on file: {currentReason}</p>
      )}

      <form action={handleSubmit} className={styles.form}>
        <div className={styles.field}>
          <label htmlFor="reason" className={styles.label}>
            Reason (required)
          </label>
          <textarea
            id="reason"
            name="reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className={styles.textarea}
            placeholder="e.g. incident-42: suspected card-testing fraud"
            required
          />
        </div>

        <button
          type="submit"
          disabled={pending}
          className={currentPaused ? `${styles.button} ${styles.resumeButton}` : styles.button}
        >
          {pending ? 'Pending...' : actionLabel}
        </button>
      </form>

      <p className={styles.error} role="alert">
        {error}
      </p>
      <p className={styles.confirmation} role="status">
        {confirmation}
      </p>
    </section>
  )
}
