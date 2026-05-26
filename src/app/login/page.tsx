import { signInWithPassword } from './actions'
import { OAuthButtons } from './oauth-buttons'
import { safeNext } from '../../lib/safeNext'
import styles from '../hub/hub.module.css'

export const metadata = { title: 'Sign In' }

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string; next?: string }>
}) {
  const params = await searchParams
  const next = safeNext(params.next)

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

        {params.message && (
          <p
            style={{
              marginBottom: 'var(--space-md)',
              textAlign: 'center',
              fontSize: '0.9rem',
              color: 'var(--color-success)',
            }}
          >
            {params.message}
          </p>
        )}

        <form action={signInWithPassword}>
          <input type="hidden" name="next" value={next} />
          <input
            className={styles.inputField}
            type="email"
            name="email"
            placeholder="Email address"
            autoComplete="email"
            required
          />
          <input
            className={styles.inputField}
            type="password"
            name="password"
            placeholder="Password"
            autoComplete="current-password"
            required
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
          <button className={styles.submitButton} type="submit">
            Sign In
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

        {params.error && (
          <p
            style={{
              marginTop: 'var(--space-md)',
              textAlign: 'center',
              fontSize: '0.9rem',
              color: 'var(--color-accent)',
            }}
          >
            {params.error}
          </p>
        )}

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
      </div>
    </div>
  )
}
