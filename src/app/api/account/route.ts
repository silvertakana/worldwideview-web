import { NextResponse } from 'next/server'
import { createClient } from '../../../lib/supabase/server'
import { crossServiceFetch } from '../../../lib/cross-service/fetch'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const res = await crossServiceFetch('/api/account', {
    searchParams: { userId: user.id },
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
