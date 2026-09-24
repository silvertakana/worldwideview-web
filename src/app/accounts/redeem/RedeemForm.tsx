'use client'

import React, { useState } from 'react'
import { useRouter } from 'next/navigation'
import { redeemCode } from './actions'
import styles from './RedeemForm.module.css'

export default function RedeemForm() {
  const router = useRouter()
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!code.trim()) { setError('Please enter an access code'); return }

    setLoading(true)
    try {
      const result = await redeemCode(code)

      if ('error' in result) {
        setError(result.error)
        // Left un-reset before, so one rejection disabled the button for good:
        // a mistyped code could not be retyped. The partial failure (the code
        // landed, the globe was not told) reaches this branch too, and its
        // message tells the customer not to enter the code again.
        setLoading(false)
        return
      }

      router.push('/accounts/instances')
    } catch {
      setError('Something went wrong. Please try again.')
    }
    setLoading(false)
  }

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <h1 className={styles.title}>Redeem Access Code</h1>
      <p className={styles.description}>
        Enter your access code to unlock cloud instance creation.
      </p>
      <input
        type="text"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="Enter your code"
        className={styles.input}
        disabled={loading}
        autoComplete="off"
        autoFocus
      />
      {error && <p className={styles.error}>{error}</p>}
      <button type="submit" className={styles.button} disabled={loading}>
        {loading ? 'Redeeming...' : 'Redeem Code'}
      </button>
    </form>
  )
}
