import hubStyles from '../../hub/hub.module.css'
import styles from '../../accounts/accounts.module.css'

export const metadata = { title: 'Check Your Email' }

export default async function CheckEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>
}) {
  const params = await searchParams
  const email = params.email

  return (
    <div className={hubStyles.hubContainer}>
      <div className={hubStyles.glassCard} style={{ maxWidth: '400px', marginTop: '6vh' }}>
        <div
          style={{
            fontSize: '3rem',
            textAlign: 'center',
            color: 'var(--color-accent)',
            marginBottom: 'var(--space-lg)',
          }}
        >
          &#9993;
        </div>
        <h1 className={hubStyles.title}>Check Your Email</h1>
        <p
          style={{
            textAlign: 'center',
            color: 'var(--color-text-secondary)',
            marginBottom: 'var(--space-md)',
          }}
        >
          We sent a verification link to{' '}
          <strong>{email ?? 'your email address'}</strong>. Click the link to activate your
          account.
        </p>
        <p
          style={{
            textAlign: 'center',
            color: 'var(--color-text-muted)',
            fontSize: '0.85rem',
            marginTop: 'var(--space-lg)',
          }}
        >
          Didn&apos;t receive it? Check your spam folder, or sign up again with the same email.
        </p>
        <p className={styles.navLink}>
          <a href="/login">Back to Sign In</a>
        </p>
      </div>
    </div>
  )
}
