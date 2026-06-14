'use server'

import { redirect } from 'next/navigation'
import { createClient } from '../../lib/supabase/server'

const API_URL = process.env.PROVISIONING_API_URL || 'http://localhost:3000'
const API_KEY = process.env.PROVISIONING_API_KEY

export async function provisionWorkspace(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?next=/provision')
  }

  const subdomain = String(formData.get('subdomain') ?? '').trim().toLowerCase()
  const plan = String(formData.get('plan') ?? 'pro')
  const displayName = String(formData.get('displayName') ?? '').trim()
  const accessCode = String(formData.get('accessCode') ?? '').trim().toUpperCase()

  if (!subdomain) {
    return { error: 'Subdomain is required' }
  }

  if (!API_KEY) {
    return { error: 'Provisioning service is not configured' }
  }

  const body: Record<string, unknown> = {
    subdomain,
    name: displayName || subdomain,
    userId: user.id,
    email: user.email ?? '',
  }

  if (accessCode) {
    body.accessCode = accessCode
  }

  const res = await fetch(`${API_URL}/api/workspace`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
    body: JSON.stringify(body),
  })

  const data = await res.json().catch(() => ({ error: 'Provisioning service error' }))

  if (!res.ok) {
    return { error: data.error || 'Failed to create workspace' }
  }

  const workspaceDomain = process.env.NEXT_PUBLIC_WORKSPACE_DOMAIN || 'cloud-wwv.dev'
  redirect(`https://${data.workspace.subdomain}.${workspaceDomain}`)
}
