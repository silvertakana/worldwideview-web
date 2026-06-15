import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'

const API_URL = process.env.PROVISIONING_API_URL || 'https://wwv.local:3443'
const API_KEY = process.env.PROVISIONING_API_KEY

export async function POST() {
  if (!API_KEY) {
    return NextResponse.json({ error: 'Provisioning API not configured' }, { status: 500 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const res = await fetch(`${API_URL}/api/billing/portal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
    body: JSON.stringify({ userId: user.id }),
  })

  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}
