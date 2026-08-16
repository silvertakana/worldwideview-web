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

  // Stamp a small DiceBear provenance marker onto the new user's metadata
  // (avatar_source: 'dicebear' only -- NOT the generated SVG). Storing the
  // full ~5-7KB SVG data URL here would be embedded by GoTrue into every
  // access-token JWT, blowing the Authorization header past Kong's 8KB limit;
  // /api/avatar regenerates the deterministic face offline from the email
  // seed instead. Best-effort -- a failed marker write must never block
  // signup. An email signup never carries an OAuth avatar, so stamping is
  // safe; the helper also skips users that somehow already have an avatar_url.
  if (data?.user) {
    try {
      await storeDicebearAvatarAtSignup(createAdminClient(), data.user.id)
    } catch (err) {
      console.error('[signup] avatar store failed:', err)
    }
  }

  redirect(
    `/login?message=${encodeURIComponent('Check your email to confirm your account, then sign in.')}&next=${encodeURIComponent(next)}`,
  )
}
