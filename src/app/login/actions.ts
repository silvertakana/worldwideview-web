'use server'

import { redirect } from 'next/navigation'
import { createClient } from '../../lib/supabase/server'
import { safeNext } from '../../lib/safeNext'

export async function signInWithPassword(formData: FormData) {
  const email = String(formData.get('email') ?? '')
  const password = String(formData.get('password') ?? '')
  const next = safeNext(String(formData.get('next') ?? ''))

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    redirect(
      `/login?error=${encodeURIComponent(error.message)}&next=${encodeURIComponent(next)}`,
    )
  }

  redirect(next)
}
