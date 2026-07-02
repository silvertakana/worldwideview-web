import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { crossServiceFetch } from '../../../../lib/cross-service/fetch'

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

  const { user } = auth

  const instancesRes = await crossServiceFetch('/api/instance', {
    searchParams: { userId: user.id, email: user.email },
  })
  const instancesData = await instancesRes.json().catch(() => ({ instances: [] }))

  const accountRes = await crossServiceFetch('/api/account', {
    searchParams: { userId: user.id },
  })
  const accountData = await accountRes.json().catch(() => null)

  // Map instances to workspaces format and merge account info
  const workspaces = (instancesData.instances || []).map((inst: any) => ({
    id: inst.id,
    name: inst.name,
    subdomain: inst.subdomain,
    status: inst.status,
    createdAt: inst.createdAt,
  }))

  return NextResponse.json({
    workspaces,
    account: accountData ? {
      plan: accountData.account?.plan || accountData.plan || 'local',
      status: accountData.account?.status || accountData.status || 'active',
      trialEndsAt: accountData.account?.trialEndsAt || accountData.trialEndsAt || null,
      instanceCount: accountData.account?.instanceCount || accountData.instanceCount || 0,
      instanceLimit: accountData.account?.instanceLimit || accountData.instanceLimit || Infinity,
      isTrialing: accountData.account?.isTrialing || accountData.isTrialing || false,
      trialDaysRemaining: accountData.account?.trialDaysRemaining || accountData.trialDaysRemaining || null,
    } : null,
  })
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

  const res = await crossServiceFetch('/api/provision', {
    method: 'POST',
    body: {
      email: user.email,
      name: body.name || user.email,
      hubUserId: user.id,
      subdomain: body.subdomain,
    },
  })

  const data = await res.json().catch(() => null)
  if (!res.ok) {
    return NextResponse.json(data || { error: 'Provisioning service error' }, { status: res.status })
  }

  return NextResponse.json({
    setupUrl: data.setupUrl,
    setupToken: data.setupToken,
  })
}
