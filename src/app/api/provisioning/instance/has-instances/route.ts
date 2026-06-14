import { NextResponse } from 'next/server'
import { createClient } from '../../../../../lib/supabase/server'

const API_URL = process.env.PROVISIONING_API_URL || 'http://localhost:3000'
const API_KEY = process.env.PROVISIONING_API_KEY

export async function GET() {
  if (!API_KEY) {
    return NextResponse.json({ error: 'Not configured' }, { status: 500 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const res = await fetch(
    `${API_URL}/api/instance?userId=${user.id}&email=${encodeURIComponent(user.email ?? '')}`,
    { headers: { 'x-api-key': API_KEY } }
  )
  const data = await res.json().catch(() => ({ workspaces: [] }))

  return NextResponse.json({ hasInstances: (data.workspaces?.length ?? 0) > 0 })
}
