'use client'

import React from 'react'
import { supabase } from '../../../lib/supabase/client'

export default function BillingPage() {
  const handleUpgrade = async (tier: string) => {
    const { data, error } = await supabase.functions.invoke('create-checkout-session', {
      body: { tier, tenantId: 'placeholder-tenant-id' }
    })
    
    if (data?.url) {
      window.location.href = data.url
    } else {
      console.error('Failed to create checkout session', error)
    }
  }

  return (
    <div style={{ padding: '2rem' }}>
      <h1>Billing</h1>
      <div>
        <h3>Pro Tier</h3>
        <button onClick={() => handleUpgrade('pro')}>Upgrade to Pro</button>
      </div>
    </div>
  )
}
