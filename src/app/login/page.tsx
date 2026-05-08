'use client'

import React, { useState } from 'react'
import { supabase } from '../../lib/supabase/client'
import styles from '../hub/hub.module.css'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setMessage('')
    
    const { error } = await supabase.auth.signInWithOtp({ 
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/hub`
      }
    })
    
    setLoading(false)
    if (error) {
      setMessage(`Error: ${error.message}`)
    } else {
      setMessage('Check your email for the login link!')
    }
  }

  return (
    <div className={styles.hubContainer}>
      <div className={styles.glassCard} style={{ maxWidth: '400px', marginTop: '10vh' }}>
        <h1 className={styles.title}>Welcome Back</h1>
        <p style={{ textAlign: 'center', marginBottom: 'var(--space-lg)', color: 'var(--text-secondary)' }}>
          Sign in to your WorldWideView account
        </p>
        
        <form onSubmit={handleLogin}>
          <input 
            className={styles.inputField}
            type="email" 
            placeholder="Email address" 
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required 
          />
          <button className={styles.submitButton} type="submit" disabled={loading}>
            {loading ? 'Sending...' : 'Send Magic Link'}
          </button>
        </form>
        
        {message && (
          <p style={{ 
            marginTop: 'var(--space-md)', 
            textAlign: 'center', 
            fontSize: '0.9rem',
            color: message.startsWith('Error') ? 'var(--color-accent)' : 'var(--color-success)'
          }}>
            {message}
          </p>
        )}
      </div>
    </div>
  )
}
