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

  const { user } = auth

  // Fetch instances from globe
  const instancesRes = await fetch(`${API_URL}/api/instance?userId=${user.id}&email=${encodeURIComponent(user.email)}`, {
    headers: { 'x-api-key': API_KEY! },
  })
  const instancesData = await instancesRes.json().catch(() => ({ instances: [] }))

  // Fetch account info from globe
  const accountRes = await fetch(`${API_URL}/api/account?userId=${user.id}`, {
    headers: { 'x-api-key': API_KEY! },
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
