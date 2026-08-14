'use server'

import { redirect } from 'next/navigation'
import { createClient } from '../../lib/supabase/server'
import { createAdminClient } from '../../lib/supabase/admin'
import { storeDicebearAvatarAtSignup } from '../../lib/avatarStore'
import { safeNext } from '../../lib/safeNext'

export async function signUp(formData: FormData) {
  const email = String(formData.get('email') ?? '')
  const password = String(formData.get('password') ?? '')
  const next = safeNext(String(formData.get('next') ?? ''))

  const supabase = await createClient()
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? ''
  // nosemgrep: semgrep.auth-error-swallowed - error handled by redirect below
  const { data, error } = await supabase.auth.signUp({
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

  // Store-once: stamp a deterministic DiceBear avatar (offline-generated) onto
  // the new user's metadata now, so /api/avatar serves it as a stored data URL
  // instead of regenerating on every render. Best-effort -- a failed avatar
  // write (e.g. missing service-role key) must never block signup. An email
  // signup never carries an OAuth avatar, so stamping is safe; the helper also
  // skips users that somehow already have an avatar_url.
  if (data?.user) {
    try {
      await storeDicebearAvatarAtSignup(
        createAdminClient(),
        data.user.id,
        data.user.email ?? email,
      )
    } catch (err) {
      console.error('[signup] avatar store failed:', err)
    }
  }

  redirect(
    `/login?message=${encodeURIComponent('Check your email to confirm your account, then sign in.')}&next=${encodeURIComponent(next)}`,
  )
}
