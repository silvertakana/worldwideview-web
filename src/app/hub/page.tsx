'use client'

import React, { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase/client'

interface Tenant {
  id: string
  name: string
  slug: string
  tier: string
}

export default function HubDashboard() {
  const [tenants, setTenants] = useState<Tenant[]>([])

  useEffect(() => {
    const fetchTenants = async () => {
      const { data } = await supabase.from('Tenant').select('*')
      if (data) setTenants(data)
    }
    fetchTenants()
  }, [])

  return (
    <div style={{ padding: '2rem' }}>
      <h1>Your Workspaces</h1>
      <ul>
        {tenants.map(tenant => (
          <li key={tenant.id}>
            {tenant.name} - <a href={`https://${tenant.slug}.app.worldwideview.dev`}>Launch</a>
          </li>
        ))}
      </ul>
      <button onClick={() => alert('Provisioning to be implemented')}>Create Workspace</button>
    </div>
  )
}
