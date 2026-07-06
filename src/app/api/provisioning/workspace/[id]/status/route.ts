import { NextResponse } from 'next/server'
import { createClient } from '../../../../../../lib/supabase/server'
import { crossServiceFetch } from '../../../../../../lib/cross-service/fetch'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params

  // Proxy to globe's /api/instance/{id}/status endpoint
  // TODO: the globe endpoint is being created in parallel -- this will 404
  // until that endpoint exists, and the client falls back to showing Launch.
  const res = await crossServiceFetch(`/api/instance/${id}/status`, {
    searchParams: { userId: user.id },
  })

  if (res.status === 404) {
    return NextResponse.json({ setupCompleted: true, note: 'Status endpoint not implemented' }, { status: 200 })
  }

  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}
