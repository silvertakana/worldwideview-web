'use server'

import { redirect } from 'next/navigation'
import { createClient } from '../../lib/supabase/server'
import { safeNext } from '../../lib/safeNext'
import { crossServiceFetch } from '../../lib/cross-service/fetch'

async function userHasInstances(userId: string, email: string): Promise<boolean> {
  try {
    const res = await crossServiceFetch('/api/instance', {
      searchParams: { userId, email },
    })
    if (!res.ok) return false
    const data = await res.json().catch(() => ({ instances: [] }))
    return (data.instances?.length ?? 0) > 0
  } catch {
    return false
  }
}

export async function signInWithPassword(formData: FormData) {
  const email = String(formData.get('email') ?? '')
  const password = String(formData.get('password') ?? '')
  const next = safeNext(String(formData.get('next') ?? ''))

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    redirect(
      `/login?error=${encodeURIComponent(error.message)}&next=${encodeURIComponent(next)}`,
    )
  }

  // If user came from a specific page (marketplace, etc.), send them back there
  if (next !== '/accounts') {
    redirect(next)
  }

  // Otherwise, check if they have workspaces to decide where to send them
  if (data.user) {
    const hasInstances = await userHasInstances(data.user.id, data.user.email ?? '')
    redirect(hasInstances ? '/hub' : '/pricing')
  }

  redirect('/pricing')
}
