'use server'

import { redirect } from 'next/navigation'
import { createClient } from '../../lib/supabase/server'
import { safeNext } from '../../lib/safeNext'

export async function signUp(formData: FormData) {
  const email = String(formData.get('email') ?? '')
  const password = String(formData.get('password') ?? '')
  const next = safeNext(String(formData.get('next') ?? ''))

  const supabase = await createClient()
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? ''
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${siteUrl}/api/auth/callback?next=${encodeURIComponent(next)}`,
    },
  })

  if (error) {
    redirect(
      `/signup?error=${encodeURIComponent(error.message)}&next=${encodeURIComponent(next)}`,
    )
  }

  redirect(
    `/login?message=${encodeURIComponent('Check your email to confirm your account, then sign in.')}&next=${encodeURIComponent(next)}`,
  )
}
