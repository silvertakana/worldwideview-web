'use client'

import { useEffect, useRef, useState } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import type { AuthChangeEvent } from '@supabase/supabase-js'
import styles from '../../../accounts/accounts.module.css'
import hubStyles from '../../../hub/hub.module.css'

export default function ResetPasswordConfirmPage() {
  const [ready, setReady] = useState(false)
  const [linkError, setLinkError] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Create browser client lazily on first client-side access.
  // The ref is null during SSR (where env vars are unavailable) and
  // populated on the first useEffect call, which only runs in the browser.
  const supabaseRef = useRef<ReturnType<typeof createBrowserClient> | null>(null)
  function getSupabase() {
    if (!supabaseRef.current) {
      supabaseRef.current = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      )
    }
    return supabaseRef.current
  }

  useEffect(() => {
    const supabase = getSupabase()

    // If no recovery fragment yet, start a 3-second fallback timer
    if (typeof window !== 'undefined' && !window.location.hash.includes('type=recovery')) {
      timerRef.current = setTimeout(() => {
        setLinkError((current) => {
          if (!current) return true
          return current
        })
      }, 3000)
    }

    const { data: subscription } = supabase.auth.onAuthStateChange((event: AuthChangeEvent) => {
      if (event === 'PASSWORD_RECOVERY') {
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        setReady(true)
      }
      if (event === 'SIGNED_OUT') {
        setLinkError(true)
      }
    })

    return () => {
      subscription.subscription.unsubscribe()
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const password = String(fd.get('password') ?? '')
    const confirm = String(fd.get('confirmPassword') ?? '')

    if (password !== confirm) {
      setFormError("Passwords don't match.")
      return
    }
    if (password.length < 8) {
      setFormError('Password must be at least 8 characters.')
      return
    }

    setIsPending(true)
    setFormError(null)
    const { error } = await getSupabase().auth.updateUser({ password })
    if (error) {
      setFormError('Unable to update password. The link may have expired.')
      setIsPending(false)
      return
    }
    // Full navigation so middleware re-evaluates the session cleanly
    window.location.href =
      '/login?message=Password+updated.+Sign+in+with+your+new+password.'
  }

  return (
    <div className={hubStyles.hubContainer}>
      <div className={hubStyles.glassCard} style={{ maxWidth: '400px', marginTop: '6vh' }}>
        {linkError ? (
          <>
            <h1 className={hubStyles.title}>Link Expired</h1>
            <p
              style={{
                textAlign: 'center',
                color: 'var(--color-text-secondary)',
                marginBottom: 'var(--space-lg)',
              }}
            >
              This reset link has expired or already been used. Request a new one.
            </p>
            <p className={styles.navLink}>
              <a href="/auth/reset-password">Request new link</a>
            </p>
          </>
        ) : !ready ? (
          <>
            <h1 className={hubStyles.title}>Set New Password</h1>
            <p
              style={{
                textAlign: 'center',
                color: 'var(--color-text-muted)',
              }}
            >
              Verifying reset link...
            </p>
          </>
        ) : (
          <>
            <h1 className={hubStyles.title}>Set New Password</h1>
            <p
              style={{
                textAlign: 'center',
                color: 'var(--color-text-secondary)',
                marginBottom: 'var(--space-lg)',
              }}
            >
              Choose a new password for your account.
            </p>
            <form onSubmit={handleSubmit}>
              <input
                className={hubStyles.inputField}
                type="password"
                name="password"
                placeholder="New password"
                autoComplete="new-password"
                minLength={8}
                autoFocus
                required
              />
              <input
                className={hubStyles.inputField}
                type="password"
                name="confirmPassword"
                placeholder="Confirm new password"
                autoComplete="new-password"
                minLength={8}
                required
              />
              <button className={hubStyles.submitButton} type="submit" disabled={isPending}>
                {isPending ? 'Updating...' : 'Update Password'}
              </button>
            </form>
            {formError && (
              <p className={styles.errorText} role="alert">
                {formError}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
