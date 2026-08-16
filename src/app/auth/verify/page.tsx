'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { verifyEmail } from './actions'
import { safeNext } from '../../../lib/safeNext'
import hubStyles from '../../hub/hub.module.css'
import styles from '../../accounts/accounts.module.css'

function VerifyContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const code = searchParams.get('code')
  const next = searchParams.get('next')
  // A missing code is not an async outcome -- derive it as the initial state
  // instead of setting it from inside an effect.
  const [status, setStatus] = useState<'processing' | 'success' | 'error'>(() =>
    code ? 'processing' : 'error',
  )

  useEffect(() => {
    if (!code) return
    const target = safeNext(next)
    verifyEmail(code).then((result) => {
      if (result.success) {
        router.replace(target)
      } else {
        setStatus('error')
      }
    })
    // code/next are plain strings from the URL and router is a stable ref, so
    // the effect only re-runs if the params change while the page is open.
  }, [code, next, router])

  return (
    <div className={hubStyles.hubContainer}>
      <div className={hubStyles.glassCard} style={{ maxWidth: '400px', marginTop: '6vh' }}>
        {status === 'processing' && (
          <>
            <h1 className={hubStyles.title}>Verifying...</h1>
            <div className={styles.spinner} aria-label="Verifying your email" />
          </>
        )}

        {status === 'success' && (
          <>
            <h1 className={hubStyles.title}>Email Verified</h1>
            <p
              style={{
                textAlign: 'center',
                color: 'var(--color-text-secondary)',
                marginBottom: 'var(--space-lg)',
              }}
            >
              You&apos;re all set.
            </p>
            <p className={styles.navLink}>
              <a href="/accounts">Go to your account</a>
            </p>
          </>
        )}

        {status === 'error' && (
          <>
            <h1 className={hubStyles.title}>Verification Failed</h1>
            <p
              style={{
                textAlign: 'center',
                color: 'var(--color-text-secondary)',
                marginBottom: 'var(--space-lg)',
              }}
            >
              This verification link has expired or already been used.
            </p>
            <p className={styles.navLink}>
              <a href="/auth/reset-password">Request a new link</a>
            </p>
            <p className={styles.navLink}>
              <a href="/login">Back to Sign In</a>
            </p>
          </>
        )}
      </div>
    </div>
  )
}

export default function VerifyPage() {
  return (
    <Suspense
      fallback={
        <div className={hubStyles.hubContainer}>
          <div className={hubStyles.glassCard} style={{ maxWidth: '400px', marginTop: '6vh' }}>
            <h1 className={hubStyles.title}>Verifying...</h1>
            <div className={styles.spinner} aria-label="Loading" />
          </div>
        </div>
      }
    >
      <VerifyContent />
    </Suspense>
  )
}
