import React from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '../../lib/supabase/server'

export default async function HubLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()
  if (!data?.claims) {
    redirect('/login?next=/hub')
  }

  return (
    <div>
      <nav style={{ padding: '1rem', background: '#eee' }}>
        <h2>Cloud Orchestrator Hub</h2>
      </nav>
      <main>{children}</main>
    </div>
  )
}
