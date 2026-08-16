import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { crossServiceFetch } from '../../../../lib/cross-service/fetch'
import { getHighestTier } from '../../../../lib/auth/entitlements'

async function requireUser(): Promise<{ user: { id: string; email: string }; response: null } | { user: null; response: NextResponse }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { user: null, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  return { user: { id: user.id, email: user.email ?? '' }, response: null }
}

interface GlobeInstance {
  id: string
  name: string
  subdomain?: string | null
  status?: string
  createdAt?: string
}

export async function GET() {
  const auth = await requireUser()
  if (auth.response) return auth.response

  const { user } = auth

  const instancesRes = await crossServiceFetch('/api/instance', {
    searchParams: { userId: user.id, email: user.email },
  })
  const instancesData = (await instancesRes.json().catch(() => ({ instances: [] }))) as {
    instances?: GlobeInstance[]
  }

  // Get user's tier from hub entitlements (source of truth)
  const userTier = await getHighestTier(user.id)

  const TIER_INSTANCE_LIMITS: Record<string, number | null> = {
    free: null,
    beta_tester: 1,
    early_access: 3,
    pro: null,
    enterprise: null,
  }
  const instanceLimit = TIER_INSTANCE_LIMITS[userTier] ?? null

  // Map instances to workspaces format
  const workspaces = (instancesData.instances || []).map((inst) => ({
    id: inst.id,
    name: inst.name,
    subdomain: inst.subdomain,
    status: inst.status,
    createdAt: inst.createdAt,
  }))

  return NextResponse.json({
    workspaces,
    account: {
      tier: userTier,
      plan: userTier === 'free' ? 'local' : userTier,
      status: 'active',
      trialEndsAt: null,
      instanceCount: workspaces.length,
      instanceLimit,
      isTrialing: false,
      trialDaysRemaining: null,
    },
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
