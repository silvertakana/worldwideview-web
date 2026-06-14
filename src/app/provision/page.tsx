'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { provisionWorkspace } from './actions'
import styles from './page.module.css'

const PLANS: Record<string, string> = {
  pro: 'Cloud Pro',
}

export default function ProvisionPage() {
  const searchParams = useSearchParams()
  const plan = searchParams.get('plan') || 'pro'
  const [subdomain, setSubdomain] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [showAccessCode, setShowAccessCode] = useState(false)
  const [accessCode, setAccessCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const formData = new FormData()
    formData.set('subdomain', subdomain)
    formData.set('displayName', displayName)
    formData.set('plan', plan)
    if (accessCode) formData.set('accessCode', accessCode)

    const result = await provisionWorkspace(formData)
    if (result?.error) {
      setError(result.error)
      setLoading(false)
    }
  }

  const workspaceDomain = process.env.NEXT_PUBLIC_WORKSPACE_DOMAIN || 'cloud-wwv.dev'

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.heading}>Create Your Instance</h1>
        <p className={styles.subtitle}>
          Pick a subdomain and your instance goes live instantly.
        </p>

        <div className={styles.planSummary}>
          <span className={styles.planName}>{PLANS[plan] || 'Cloud Pro'}</span>
          <span className={styles.planBadge}>7-Day Free Trial</span>
        </div>

        <form onSubmit={handleSubmit}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="displayName">
              Display Name <span style={{ fontWeight: 400, color: 'var(--color-text-muted)' }}>(optional)</span>
            </label>
            <input
              id="displayName"
              type="text"
              className={styles.input}
              placeholder="My Workspace"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="off"
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="subdomain">
              Subdomain
            </label>
            <input
              id="subdomain"
              type="text"
              className={styles.input}
              placeholder="my-workspace"
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              autoComplete="off"
              required
            />
            <p className={styles.suffix}>{subdomain || 'my-workspace'}.{workspaceDomain}</p>
          </div>

          <div className={styles.accessCodeField}>
            {!showAccessCode ? (
              <button
                type="button"
                className={styles.accessCodeToggle}
                onClick={() => setShowAccessCode(true)}
              >
                Have an access code?
              </button>
            ) : (
              <div className={styles.field}>
                <label className={styles.label} htmlFor="accessCode">
                  Access Code
                </label>
                <input
                  id="accessCode"
                  type="text"
                  className={styles.input}
                  placeholder="BETA-XXXX-XXXX"
                  value={accessCode}
                  onChange={(e) => setAccessCode(e.target.value.toUpperCase())}
                  autoComplete="off"
                />
              </div>
            )}
          </div>

          <button type="submit" className={styles.submitBtn} disabled={loading || !subdomain}>
            {loading ? 'Creating...' : 'Start Free Trial'}
          </button>
        </form>

        {error && <p className={styles.error}>{error}</p>}

        <p className={styles.trialInfo}>
          No credit card required. 7-day trial, cancel anytime.
        </p>
      </div>
    </div>
  )
}
