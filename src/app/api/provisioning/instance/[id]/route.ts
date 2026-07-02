import { NextResponse } from 'next/server'
import { createClient } from '../../../../../lib/supabase/server'
import { crossServiceFetch } from '../../../../../lib/cross-service/fetch'

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

  const res = await crossServiceFetch(`/api/instance/${id}`, {
    method: 'PATCH',
    body,
  })

  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params

  const res = await crossServiceFetch(`/api/instance/${id}`, {
    method: 'DELETE',
  })

  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}
