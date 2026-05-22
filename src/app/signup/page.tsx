import { signUp } from './actions'
import { safeNext } from '../../lib/safeNext'
import styles from '../hub/hub.module.css'

export const metadata = { title: 'Create Account' }

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>
}) {
  const params = await searchParams
  const next = safeNext(params.next)

  return (
    <div className={styles.hubContainer}>
      <div className={styles.glassCard} style={{ maxWidth: '400px', marginTop: '6vh' }}>
        <h1 className={styles.title}>Create Account</h1>
        <p
          style={{
            textAlign: 'center',
            marginBottom: 'var(--space-lg)',
            color: 'var(--color-text-secondary)',
          }}
        >
          One account for the whole WorldWideView ecosystem
        </p>

        <form action={signUp}>
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
            placeholder="Password (8+ characters)"
            autoComplete="new-password"
            minLength={8}
            required
          />
          <button className={styles.submitButton} type="submit">
            Sign Up
          </button>
        </form>

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
          Already have an account?{' '}
          <a
            href={`/login?next=${encodeURIComponent(next)}`}
            style={{ color: 'var(--color-accent)', fontWeight: 500 }}
          >
            Sign in
          </a>
        </p>
      </div>
    </div>
  )
}
