import { NextResponse } from 'next/server'
import { createClient } from '../../../lib/supabase/server'

const API_URL = process.env.PROVISIONING_API_URL || 'https://wwv.local:3443'
const API_KEY = process.env.PROVISIONING_API_KEY

export async function GET() {
  if (!API_KEY) {
    return NextResponse.json({ error: 'Provisioning API not configured' }, { status: 500 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const res = await fetch(`${API_URL}/api/account?userId=${user.id}`, {
    headers: { 'x-api-key': API_KEY },
    cache: 'no-store',
  })

  const data = await res.json().catch(() => null)

  // On globe failure, return local plan as fallback
  if (!data) {
    return NextResponse.json({
      account: null,
      plan: 'local',
      status: 'active',
      trialEndsAt: null,
      instanceCount: 0,
      instanceLimit: Infinity,
      isTrialing: false,
      trialDaysRemaining: null,
    })
  }

  return NextResponse.json(data)
}
