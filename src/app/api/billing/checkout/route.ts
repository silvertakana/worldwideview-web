import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { crossServiceFetch } from '../../../../lib/cross-service/fetch'

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const res = await crossServiceFetch('/api/billing/checkout', {
    method: 'POST',
    body: { userId: user.id, email: user.email },
  })

  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}
