'use client'

import React, { useState } from 'react'
import { supabase } from '../../lib/supabase/client'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    await supabase.auth.signInWithOtp({ email })
    alert('Check your email for the login link!')
  }

  return (
    <div style={{ padding: '2rem' }}>
      <h1>Login</h1>
      <form onSubmit={handleLogin}>
        <input 
          type="email" 
          placeholder="Email address" 
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required 
        />
        <button type="submit">Send Magic Link</button>
      </form>
    </div>
  )
}
