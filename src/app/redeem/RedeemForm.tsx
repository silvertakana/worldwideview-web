'use client'

import React, { useState } from 'react'
import { redeemCode } from './actions'
import styles from './RedeemForm.module.css'

export default function RedeemForm() {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!code.trim()) { setError('Please enter an access code'); return }

    setLoading(true)
    const result = await redeemCode(code)
    setLoading(false)

    if (result?.error) setError(result.error)
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
