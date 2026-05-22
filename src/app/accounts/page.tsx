import { redirect } from 'next/navigation'
import { createClient } from '../../lib/supabase/server'
import { signOut } from './actions'
import styles from '../hub/hub.module.css'

export const metadata = { title: 'Your Account' }

export default async function AccountsPage() {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()
  const claims = data?.claims

  if (!claims) {
    redirect('/login?next=/accounts')
  }

  const email = typeof claims.email === 'string' ? claims.email : 'your account'

  return (
    <div className={styles.hubContainer}>
      <div className={styles.glassCard} style={{ maxWidth: '480px', marginTop: '6vh' }}>
        <h1 className={styles.title}>Your Account</h1>
        <p
          style={{
            textAlign: 'center',
            color: 'var(--color-text-secondary)',
            marginBottom: 'var(--space-lg)',
          }}
        >
          Signed in as{' '}
          <strong style={{ color: 'var(--color-text-primary)' }}>{email}</strong>
        </p>
        <form action={signOut}>
          <button className={styles.submitButton} type="submit">
            Sign Out
          </button>
        </form>
      </div>
    </div>
  )
}
