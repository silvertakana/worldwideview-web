import { NextResponse } from 'next/server'
import { createClient } from '../../../../../lib/supabase/server'

const API_URL = process.env.PROVISIONING_API_URL || 'https://wwv.local:3443'
const API_KEY = process.env.PROVISIONING_API_KEY

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!API_KEY) {
    return NextResponse.json({ error: 'Provisioning API not configured' }, { status: 500 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const res = await fetch(`${API_URL}/api/instance/${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
    body: JSON.stringify(body),
  })

  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!API_KEY) {
    return NextResponse.json({ error: 'Provisioning API not configured' }, { status: 500 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params

  const res = await fetch(`${API_URL}/api/instance/${id}`, {
    method: 'DELETE',
    headers: { 'x-api-key': API_KEY },
  })

  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}
