'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { OAuthButtons } from './oauth-buttons'
import styles from '../hub/hub.module.css'

/**
 * Client-side login form.
 *
 * Calls `createBrowserClient().auth.signInWithPassword()` directly so Supabase
 * session cookies are written to `document.cookie` synchronously, before any
 * navigation. This avoids the race in the old server-action flow where
 * `redirect()` could flush response headers before cookies were committed,
 * leaving the navbar stale until manual reload.
 *
 * After a successful sign-in the Header's `onAuthStateChange` listener fires
 * `SIGNED_IN` → `router.refresh()`, and the server-rendered layout picks up
 * the now-present session cookie on the RSC re-fetch.
 */
export default function LoginForm({
  next,
  error: initialError,
  message,
}: {
  next: string
  error?: string
  message?: string
}) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(initialError ?? null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const supabase = createClient()
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (signInError) {
      setError(signInError.message)
      setLoading(false)
      return
    }

    // If user came from a specific page (marketplace, etc.), send them back there
    if (next !== '/accounts') {
      router.push(next)
      return
    }

    // Otherwise, check if they have instances to decide where to send them
    try {
      const res = await fetch('/api/provisioning/instance/has-instances')
      if (res.ok) {
        const data = await res.json()
        router.push(data.hasInstances ? '/accounts/instances' : '/pricing')
      } else {
        router.push('/pricing')
      }
    } catch (err) {
      console.error('Failed to check instances after sign-in:', err)
      router.push('/pricing')
    }
  }

  return (
    <div className={styles.hubContainer}>
      <div className={styles.glassCard} style={{ maxWidth: '400px', marginTop: '6vh' }}>
        <h1 className={styles.title}>Welcome Back</h1>
        <p
          style={{
            textAlign: 'center',
            marginBottom: 'var(--space-lg)',
            color: 'var(--color-text-secondary)',
          }}
        >
          Sign in to your WorldWideView account
        </p>

        {message && (
          <p
            style={{
              marginBottom: 'var(--space-md)',
              textAlign: 'center',
              fontSize: '0.9rem',
              color: 'var(--color-success)',
            }}
          >
            {message}
          </p>
        )}

        <form onSubmit={handleSubmit}>
          <input type="hidden" name="next" value={next} />
          <input
            className={styles.inputField}
            type="email"
            name="email"
            placeholder="Email address"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className={styles.inputField}
            type="password"
            name="password"
            placeholder="Password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p
            style={{
              textAlign: 'right',
              fontSize: '0.9rem',
              marginBottom: 'var(--space-md)',
              marginTop: 'calc(var(--space-sm) * -1)',
            }}
          >
            <a href="/auth/reset-password" style={{ color: 'var(--color-accent)', fontWeight: 500 }}>
              Forgot password?
            </a>
          </p>
          <button className={styles.submitButton} type="submit" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div
          style={{
            textAlign: 'center',
            margin: 'var(--space-md) 0',
            color: 'var(--color-text-muted)',
            fontSize: '0.85rem',
          }}
        >
          or
        </div>

        <OAuthButtons next={next} />

        {error && (
          <div style={{ marginTop: 'var(--space-md)' }}>
            <p style={{ textAlign: 'center', fontSize: '0.9rem', color: 'var(--color-accent)' }}>
              {error}
            </p>
            {(error.toLowerCase().includes('invalid') ||
              error.toLowerCase().includes('credential')) && (
              <p
                style={{
                  textAlign: 'center',
                  fontSize: '0.875rem',
                  marginTop: 'var(--space-sm)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                No account yet?{' '}
                <a
                  href={`/signup?next=${encodeURIComponent(next)}`}
                  style={{ color: 'var(--color-accent)', fontWeight: 600 }}
                >
                  Create one free
                </a>
              </p>
            )}
          </div>
        )}

        {!error && (
          <p
            style={{
              marginTop: 'var(--space-lg)',
              textAlign: 'center',
              fontSize: '0.9rem',
              color: 'var(--color-text-secondary)',
            }}
          >
            No account?{' '}
            <a
              href={`/signup?next=${encodeURIComponent(next)}`}
              style={{ color: 'var(--color-accent)', fontWeight: 500 }}
            >
              Create one
            </a>
          </p>
        )}
      </div>
    </div>
  )
}
