import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'

const API_URL = process.env.PROVISIONING_API_URL || 'https://wwv.local:3443'
const API_KEY = process.env.PROVISIONING_API_KEY

async function requireUser(): Promise<{ user: { id: string; email: string }; response: null } | { user: null; response: NextResponse }> {
  if (!API_KEY) {
    return { user: null, response: NextResponse.json({ error: 'Provisioning API not configured' }, { status: 500 }) }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { user: null, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  return { user: { id: user.id, email: user.email ?? '' }, response: null }
}

export async function GET() {
  const auth = await requireUser()
  if (auth.response) return auth.response

  const res = await fetch(`${API_URL}/api/instance?userId=${auth.user.id}&email=${encodeURIComponent(auth.user.email)}`, {
    headers: { 'x-api-key': API_KEY! },
  })
  const data = await res.json().catch(() => null)
  return NextResponse.json(data || { workspaces: [] }, { status: res.status })
}

export async function POST(request: Request) {
  const auth = await requireUser()
  if (auth.response) return auth.response

  const { user } = auth

  let body: { subdomain?: string; name?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.subdomain) {
    return NextResponse.json({ error: 'subdomain is required' }, { status: 400 })
  }

  const res = await fetch(`${API_URL}/api/instance`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY!,
    },
    body: JSON.stringify({
      subdomain: body.subdomain,
      name: body.name || undefined,
      userId: user.id,
      email: user.email,
    }),
  })

  const data = await res.json().catch(() => null)
  return NextResponse.json(data || { error: 'Provisioning service error' }, { status: res.status })
}
