import { NextResponse } from 'next/server'
import { createClient } from '../../../../../../lib/supabase/server'
import { crossServiceFetch } from '../../../../../../lib/cross-service/fetch'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: _id } = await params
  const { searchParams } = new URL(request.url)
  const subdomain = searchParams.get('subdomain')

  if (!subdomain) {
    return NextResponse.json({ error: 'subdomain query parameter is required' }, { status: 400 })
  }

  // Call globe's idempotent provision endpoint to get a fresh setup token
  const res = await crossServiceFetch('/api/provision', {
    method: 'POST',
    body: {
      email: user.email,
      name: user.email?.split('@')[0] || 'User',
      hubUserId: user.id,
      subdomain,
    },
  })

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Provision failed' }))
    return NextResponse.json(error, { status: res.status })
  }

  const data = await res.json()
  return NextResponse.json({
    setupToken: data.setupToken,
    setupUrl: data.setupUrl,
  })
}
