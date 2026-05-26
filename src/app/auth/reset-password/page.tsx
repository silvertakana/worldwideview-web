'use client'

import { useState, useTransition } from 'react'
import { requestPasswordReset } from './actions'
import styles from '../../accounts/accounts.module.css'
import hubStyles from '../../hub/hub.module.css'

export default function ResetPasswordPage() {
  const [submitted, setSubmitted] = useState(false)
  const [submittedEmail, setSubmittedEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleSubmit(formData: FormData) {
    setError(null)
    startTransition(async () => {
      const result = await requestPasswordReset(formData)
      if (result.success) {
        setSubmittedEmail(result.email ?? '')
        setSubmitted(true)
      } else {
        setError(result.error ?? 'Something went wrong. Please try again.')
      }
    })
  }

  return (
    <div className={hubStyles.hubContainer}>
      <div className={hubStyles.glassCard} style={{ maxWidth: '400px', marginTop: '6vh' }}>
        {submitted ? (
          <>
            <h1 className={hubStyles.title}>Check Your Email</h1>
            <p className={styles.successText} role="status" style={{ textAlign: 'center' }}>
              A reset link is on its way to {submittedEmail || 'your inbox'}.
            </p>
            <p className={styles.navLink}>
              <a href="/login">Back to Sign In</a>
            </p>
          </>
        ) : (
          <>
            <h1 className={hubStyles.title}>Reset Password</h1>
            <p
              style={{
                textAlign: 'center',
                marginBottom: 'var(--space-lg)',
                color: 'var(--color-text-secondary)',
              }}
            >
              Enter your email and we&apos;ll send a reset link.
            </p>
            <form action={handleSubmit}>
              <input
                className={hubStyles.inputField}
                type="email"
                name="email"
                placeholder="Email address"
                autoComplete="email"
                autoFocus
                required
              />
              <button className={hubStyles.submitButton} type="submit" disabled={isPending}>
                {isPending ? 'Sending...' : 'Send Reset Link'}
              </button>
            </form>
            {error && (
              <p className={styles.errorText} role="alert">
                {error}
              </p>
            )}
            <p className={styles.navLink}>
              Remember your password?{' '}
              <a href="/login">Sign in</a>
            </p>
          </>
        )}
      </div>
    </div>
  )
}
