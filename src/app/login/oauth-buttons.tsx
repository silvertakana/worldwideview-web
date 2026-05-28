'use client'

import { useState, useTransition } from 'react'
import { signInWithOAuth } from './oauth-actions'
import styles from '../hub/hub.module.css'

const outlineStyle = {
  background: 'transparent',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)',
}

type Provider = 'google' | 'github'

export function OAuthButtons({ next }: { next: string }) {
  const [isPending, startTransition] = useTransition()
  const [pendingProvider, setPendingProvider] = useState<Provider | null>(null)
  const [error, setError] = useState<string | null>(null)

  /**
   * The server action returns the provider URL; the client performs the
   * navigation via `window.location.assign`. This ensures the PKCE
   * code-verifier cookie set by Supabase on the action response is committed
   * to the browser cookie jar BEFORE the provider redirect, preventing
   * `bad_oauth_state` on the eventual return through Supabase's callback.
   * See `oauth-actions.ts` for the full reasoning.
   */
  function handleClick(provider: Provider) {
    setError(null)
    setPendingProvider(provider)
    startTransition(async () => {
      const result = await signInWithOAuth(provider, next)
      if (!result.ok) {
        setError(result.error)
        setPendingProvider(null)
        return
      }
      window.location.assign(result.url)
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
      <button
        className={styles.submitButton}
        style={outlineStyle}
        type="button"
        disabled={isPending}
        onClick={() => handleClick('google')}
      >
        {pendingProvider === 'google' ? 'Redirecting...' : 'Continue with Google'}
      </button>
      <button
        className={styles.submitButton}
        style={outlineStyle}
        type="button"
        disabled={isPending}
        onClick={() => handleClick('github')}
      >
        {pendingProvider === 'github' ? 'Redirecting...' : 'Continue with GitHub'}
      </button>
      {error && (
        <p
          role="alert"
          style={{
            textAlign: 'center',
            fontSize: '0.9rem',
            color: 'var(--color-accent)',
          }}
        >
          {error}
        </p>
      )}
    </div>
  )
}
