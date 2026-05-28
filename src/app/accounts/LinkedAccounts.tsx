'use client'

import { useEffect, useState } from 'react'
import { Github, Mail, Link2 } from 'lucide-react'
import type { UserIdentity } from '@supabase/supabase-js'
import { getIdentities, startGitHubLink } from './actions'
import styles from './accounts.module.css'

function titleCase(str: string): string {
  if (str === 'github') return 'GitHub'
  return str.charAt(0).toUpperCase() + str.slice(1)
}

function getDisplayValue(identity: UserIdentity): string {
  if (identity.provider === 'email') {
    return (identity.identity_data?.email as string | undefined) ?? identity.provider
  }
  if (identity.provider === 'github') {
    return (
      (identity.identity_data?.user_name as string | undefined) ??
      (identity.identity_data?.preferred_username as string | undefined) ??
      identity.provider
    )
  }
  return identity.provider
}

function ProviderIcon({ provider }: { provider: string }) {
  if (provider === 'github') return <Github size={18} className={styles.linkedAccountIcon} />
  if (provider === 'email') return <Mail size={18} className={styles.linkedAccountIcon} />
  return <Link2 size={18} className={styles.linkedAccountIcon} />
}

export default function LinkedAccounts() {
  const [identities, setIdentities] = useState<UserIdentity[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)

  useEffect(() => {
    getIdentities()
      .then(setIdentities)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load accounts'))
      .finally(() => setLoading(false))
  }, [])

  async function handleLinkGithub() {
    setLinking(true)
    setError(null)
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? window.location.origin
    try {
      const url = await startGitHubLink(`${siteUrl}/accounts?linked=1`)
      window.location.href = url
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to start GitHub linking')
      setLinking(false)
    }
  }

  if (loading) {
    return <p className={styles.inlineSuccess}>Loading linked accounts...</p>
  }

  const hasGithub = identities?.some((id) => id.provider === 'github') ?? false

  return (
    <>
      {error && <p className={styles.inlineError}>{error}</p>}

      {identities && identities.length > 0 && (
        <ul className={styles.linkedAccountsList}>
          {identities.map((identity) => (
            <li key={identity.id} className={styles.linkedAccountItem}>
              <ProviderIcon provider={identity.provider} />
              <span className={styles.linkedAccountLabel}>
                {titleCase(identity.provider)}
              </span>
              <span className={styles.linkedAccountMeta}>
                {getDisplayValue(identity)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {!hasGithub && (
        <button
          type="button"
          className={styles.linkGithubButton}
          disabled={linking}
          onClick={handleLinkGithub}
        >
          <Github size={16} />
          {linking ? 'Redirecting to GitHub...' : 'Link GitHub account'}
        </button>
      )}
    </>
  )
}
