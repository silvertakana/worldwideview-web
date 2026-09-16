'use client'

import { useState } from 'react'
import type { LookupResult } from '@/lib/billing/customer-lookup'
import { CustomerPanel } from './CustomerPanel'
import { grantOverride, lookupCustomer, retryGlobePush, revokeOverrideAction } from './actions'
import styles from './overrides.module.css'

type Notice = { tone: 'ok' | 'error'; text: string }

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function OverrideConsole() {
  const [result, setResult] = useState<LookupResult | null>(null)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [retryTier, setRetryTier] = useState<string | null>(null)

  async function search(query: string) {
    setPending(true)
    setNotice(null)
    setRetryTier(null)
    try {
      setResult(await lookupCustomer(query))
    } catch (err) {
      setNotice({ tone: 'error', text: `The lookup itself failed: ${describe(err)}` })
    } finally {
      setPending(false)
    }
  }

  async function handleSearch(formData: FormData) {
    await search(String(formData.get('query') ?? ''))
  }

  async function handleGrant(tier: string, reason: string) {
    if (!result?.ok) return
    const customer = result.customer
    setPending(true)
    setNotice(null)
    setRetryTier(null)
    try {
      const granted = await grantOverride({
        userId: customer.userId,
        email: customer.email,
        tier,
        reason,
      })
      if (granted.ok) {
        setNotice({ tone: 'ok', text: granted.detail })
      } else if (granted.stage === 'globe') {
        // The exact state the whole project exists to make impossible to hide:
        // the hub says the override exists, the customer still has no access.
        setRetryTier(tier)
        setNotice({
          tone: 'error',
          text: `PARTIAL - the override is recorded in the hub, but the customer still does NOT have access. ${granted.error}`,
        })
      } else {
        setNotice({ tone: 'error', text: granted.error })
      }
      setResult(await lookupCustomer(customer.email))
    } catch (err) {
      setNotice({ tone: 'error', text: `The grant could not be completed: ${describe(err)}` })
    } finally {
      setPending(false)
    }
  }

  async function handleRevoke() {
    if (!result?.ok) return
    const customer = result.customer
    const override = customer.override
    if (!override) return
    const confirmed = window.confirm(
      `Revoke "${override.tier}" for ${customer.email}?\n\nThe globe tier will be recalculated from their ` +
        'remaining records, which may be lower or Free.',
    )
    if (!confirmed) return

    setPending(true)
    setNotice(null)
    setRetryTier(null)
    try {
      const revoked = await revokeOverrideAction({
        userId: customer.userId,
        email: customer.email,
        overrideId: override.id,
      })
      setNotice(revoked.ok ? { tone: 'ok', text: revoked.detail } : { tone: 'error', text: revoked.error })
      setResult(await lookupCustomer(customer.email))
    } catch (err) {
      setNotice({ tone: 'error', text: `The revoke could not be completed: ${describe(err)}` })
    } finally {
      setPending(false)
    }
  }

  async function handleRetry() {
    if (!result?.ok || !retryTier) return
    const customer = result.customer
    const tier = retryTier
    setPending(true)
    setNotice(null)
    try {
      const retried = await retryGlobePush({ userId: customer.userId, email: customer.email, tier })
      if (retried.ok) {
        setRetryTier(null)
        setNotice({ tone: 'ok', text: retried.detail })
      } else {
        setNotice({ tone: 'error', text: `Still not delivered. ${retried.error}` })
      }
      setResult(await lookupCustomer(customer.email))
    } catch (err) {
      setNotice({ tone: 'error', text: `The retry could not be completed: ${describe(err)}` })
    } finally {
      setPending(false)
    }
  }

  return (
    <div>
      <form action={handleSearch} className={styles.searchRow}>
        <div className={styles.field}>
          <label htmlFor="query" className={styles.label}>
            Customer
          </label>
          <input
            id="query"
            name="query"
            type="text"
            required
            autoComplete="off"
            placeholder="name@example.com or a hub user id"
            className={styles.searchInput}
          />
        </div>
        <button type="submit" disabled={pending} className={styles.button}>
          {pending ? 'Working...' : 'Find customer'}
        </button>
      </form>

      {notice && (
        <p className={notice.tone === 'ok' ? styles.bannerOk : styles.bannerError}>{notice.text}</p>
      )}
      {result && !result.ok && <p className={styles.bannerError}>{result.error}</p>}

      {result?.ok && (
        <CustomerPanel
          customer={result.customer}
          globe={result.globe}
          pending={pending}
          retryTier={retryTier}
          onGrant={handleGrant}
          onRevoke={handleRevoke}
          onRetry={handleRetry}
        />
      )}
    </div>
  )
}
