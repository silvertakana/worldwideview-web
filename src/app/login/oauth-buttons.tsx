'use client'

import { createClient } from '../../lib/supabase/client'
import styles from '../hub/hub.module.css'

const outlineStyle = {
  background: 'transparent',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)',
}

export function OAuthButtons({ next }: { next: string }) {
  const signIn = async (provider: 'google' | 'github') => {
    const supabase = createClient()
    await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/api/auth/callback?next=${encodeURIComponent(next)}`,
      },
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
      <button
        className={styles.submitButton}
        style={outlineStyle}
        type="button"
        onClick={() => signIn('google')}
      >
        Continue with Google
      </button>
      <button
        className={styles.submitButton}
        style={outlineStyle}
        type="button"
        onClick={() => signIn('github')}
      >
        Continue with GitHub
      </button>
    </div>
  )
}
