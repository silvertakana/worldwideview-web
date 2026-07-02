'use client'

import React, { useState, useCallback } from 'react'
import styles from './instances.module.css'

const SUBDOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const RESERVED = new Set([
  'www', 'app', 'api', 'admin', 'mail', 'demo',
  'cloud', 'default', 'wwv', 'localhost', 'staging',
  'dev', 'test', 'docs', 'support', 'help', 'status',
  'billing', 'account', 'accounts', 'auth', 'login',
])

export default function CreateInstanceForm({
  onCreated,
}: {
  onCreated: () => void
}) {
  const [subdomain, setSubdomain] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [validationError, setValidationError] = useState('')

  const validate = useCallback((value: string) => {
    const v = value.toLowerCase().trim()
    if (!v) return setValidationError('')
    if (!SUBDOMAIN_REGEX.test(v)) return setValidationError('Invalid subdomain - letters, numbers, and hyphens only')
    if (v.length < 3) return setValidationError('Subdomain must be at least 3 characters')
    if (RESERVED.has(v)) return setValidationError(`"${v}" is a reserved subdomain`)
    setValidationError('')
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    const sd = subdomain.toLowerCase().trim()
    if (!sd) { setError('Subdomain is required'); return }
    if (validationError) { setError('Fix validation errors first'); return }

    setLoading(true)
    try {
      const res = await fetch('/api/provisioning/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subdomain: sd,
          name: name || undefined,
        }),
      })

      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Failed to create workspace')
        return
      }

      if (data.setupUrl) {
        window.location.href = data.setupUrl
        return
      }

      onCreated()
    } catch {
      setError('Network error - please try again')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <h2 className={styles.formTitle}>Create New Instance</h2>

      <label className={styles.label}>
        Subdomain
        <div className={styles.inputWrapper}>
          <input
            type="text"
            value={subdomain}
            onChange={(e) => {
              setSubdomain(e.target.value)
              validate(e.target.value)
            }}
            placeholder="my-workspace"
            className={styles.inputField}
            disabled={loading}
            autoComplete="off"
            maxLength={63}
          />
          <span className={styles.inputSuffix}>.{process.env.NEXT_PUBLIC_WORKSPACE_DOMAIN || 'cloud-wwv.dev'}</span>
        </div>
        {validationError && <span className={styles.errorText}>{validationError}</span>}
      </label>

      <label className={styles.label}>
        Display Name <span className={styles.optional}>(optional)</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Workspace"
          className={styles.inputField}
          disabled={loading}
          maxLength={100}
        />
      </label>

      {error && <p className={styles.errorBox}>{error}</p>}

      <button type="submit" className={styles.submitButton} disabled={loading}>
        {loading ? 'Creating...' : 'Create Instance'}
      </button>
    </form>
  )
}
