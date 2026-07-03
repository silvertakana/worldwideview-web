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
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSuccess(false)
    if (!code.trim()) { setError('Please enter an access code'); return }

    setLoading(true)
    try {
      const result = await redeemCode(code)
      setLoading(false)

      if (result?.success) {
        setSuccess(true)
        router.push('/accounts/instances')
        return
      }

      if (result?.error) setError(result.error)
    } catch {
      setLoading(false)
      setError('Something went wrong. Please try again.')
    }
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
      {success && <p className={styles.success}>Code redeemed! Redirecting...</p>}
      <button type="submit" className={styles.button} disabled={loading}>
        {loading ? 'Redeeming...' : 'Redeem Code'}
      </button>
    </form>
  )
}
