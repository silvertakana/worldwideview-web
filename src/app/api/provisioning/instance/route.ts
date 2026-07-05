import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { crossServiceFetch } from '../../../../lib/cross-service/fetch'
import { hasInstanceEntitlement, getHighestTier, markEntitlementUsed } from '../../../../lib/auth/entitlements'

async function requireUser(): Promise<{ user: { id: string; email: string }; response: null } | { user: null; response: NextResponse }> {
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

  const res = await crossServiceFetch('/api/instance', {
    searchParams: { userId: auth.user.id, email: auth.user.email },
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
    console.warn('[provision] invalid JSON body', { userId: user.id })
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  console.log('[provision] start', { subdomain: body.subdomain, displayName: body.name, userId: user.id, email: user.email })

  if (!body.subdomain) {
    console.warn('[provision] missing subdomain', { userId: user.id })
    return NextResponse.json({ error: 'subdomain is required' }, { status: 400 })
  }

  console.log('[provision] subdomain validated', { subdomain: body.subdomain })

  const entitled = await hasInstanceEntitlement(user.id)
  if (!entitled) {
    console.warn('[provision] no entitlement', { userId: user.id, email: user.email })
    return NextResponse.json(
      { error: 'No active entitlement. Redeem an access code at /accounts/redeem.' },
      { status: 403 },
    )
  }

  const tier = await getHighestTier(user.id)
  console.log('[provision] entitlement ok', { userId: user.id, tier })

  const globeBody = {
    subdomain: body.subdomain,
    name: body.name || undefined,
    userId: user.id,
    email: user.email,
    tier,
  }
  console.log('[provision] calling globe', { url: '/api/instance', globeBody })

  let res: Response
  try {
    res = await crossServiceFetch('/api/instance', {
      method: 'POST',
      body: globeBody,
    })
  } catch (err) {
    console.error('[provision] globe network error', { error: String(err), stack: err instanceof Error ? err.stack : undefined })
    return NextResponse.json({ error: 'Cannot reach globe service. Please try again.' }, { status: 502 })
  }

  console.log('[provision] globe response', { status: res.status, ok: res.ok })

  const data = await res.json().catch(() => {
    console.warn('[provision] globe non-json response', { status: res.status })
    return null
  })
  console.log('[provision] globe body', data)

  if (!res.ok) {
    console.error('[provision] globe request failed', { status: res.status, body: data })
  }

  if (res.ok) {
    await markEntitlementUsed(user.id)
    console.log('[provision] entitlement marked used', { userId: user.id })
  }

  if (data && data.subdomain && !data.setupUrl) {
    const pattern = process.env.NEXT_PUBLIC_INSTANCE_URL_PATTERN
    if (pattern) {
      data.setupUrl = pattern.replace('{subdomain}', data.subdomain)
      console.log('[provision] setup url generated', { setupUrl: data.setupUrl })
    }
  }

  console.log('[provision] success', { subdomain: data?.subdomain, callbackUrl: data?.setupUrl })

  return NextResponse.json(data || { error: 'Provisioning service error' }, { status: res.status })
}
