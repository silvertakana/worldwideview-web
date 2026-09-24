'use client'

import { useState, useTransition } from 'react'
import { resolveFailureAction } from './actions'
import type { FailureRow } from './page'
import styles from './FailuresQueue.module.css'

export function FailuresQueue({ failures }: { failures: FailureRow[] }) {
  const [pending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')

  function resolve(id: string) {
    setError('')
    setBusyId(id)
    startTransition(async () => {
      const result = await resolveFailureAction(id)
      if (!result.ok) setError(result.error)
      setBusyId(null)
    })
  }

  if (failures.length === 0) {
    return (
      <p className={styles.empty}>
        Nothing is waiting. Every recorded billing step either completed or has already been
        handled. The nightly reconciliation run fails on this queue, so an empty screen here is
        what a green run is reporting.
      </p>
    )
  }

  return (
    <>
      {error && <p className={styles.bannerError}>{error}</p>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Waiting</th>
              <th>Stage</th>
              <th>Customer</th>
              <th>What failed</th>
              <th>Event</th>
              <th>Tries</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {failures.map((failure) => (
              <tr key={failure.id}>
                <td className={styles.nowrap}>
                  <span className={styles.age}>{failure.age}</span>
                  <span className={styles.subtle}>{failure.firstSeen}</span>
                </td>
                <td className={styles.nowrap}>{failure.stageLabel}</td>
                <td className={styles.nowrap}>
                  {failure.email || <span className={styles.subtle}>no email on file</span>}
                  <span className={styles.mono}>{failure.userId || 'no user id'}</span>
                </td>
                <td className={styles.reason}>{failure.error}</td>
                <td className={styles.nowrap}>
                  <span className={styles.mono}>{failure.eventId || '(none)'}</span>
                  <span className={styles.subtle}>{failure.eventType}</span>
                </td>
                <td className={styles.nowrap}>
                  {failure.attempts}
                  <span className={styles.subtle}>last {failure.lastAttempt}</span>
                </td>
                <td className={styles.nowrap}>
                  <button
                    type="button"
                    className={styles.buttonSecondary}
                    disabled={pending && busyId === failure.id}
                    onClick={() => resolve(failure.id)}
                  >
                    {pending && busyId === failure.id ? 'Closing...' : 'Mark handled'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
