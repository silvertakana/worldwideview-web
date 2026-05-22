'use client'

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '../../lib/supabase/client'

export default function HubLayout({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true)
  const router = useRouter()

  useEffect(() => {
    const checkSession = async () => {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        router.push('/login')
      } else {
        setLoading(false)
      }
    }
    checkSession()
  }, [router])

  if (loading) return <div>Loading Hub...</div>

  return (
    <div>
      <nav style={{ padding: '1rem', background: '#eee' }}>
        <h2>Cloud Orchestrator Hub</h2>
      </nav>
      <main>{children}</main>
    </div>
  )
}
