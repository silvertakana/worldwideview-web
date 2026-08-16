import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { safeNext } from '../../../../lib/safeNext'
import {
  avatarSourceForProvider,
  writeOAuthAvatarSource,
} from '../../../../lib/avatarStore'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = safeNext(searchParams.get('next'))
  const base = process.env.NEXT_PUBLIC_SITE_URL || origin

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error) {
      // Best-effort provenance: Supabase copies the provider's avatar_url into
      // user_metadata at OAuth signup; stamp avatar_source so the avatar's
      // origin stays answerable. Never blocks the redirect on failure.
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser()
        const source = avatarSourceForProvider(user?.app_metadata?.provider)
        if (user && source) {
          await writeOAuthAvatarSource(supabase, user, source)
        }
      } catch (err) {
        console.error('[auth/callback] avatar provenance write failed:', err)
      }
      const target = next.startsWith('https://') || next.startsWith('http://') ? next : `${base}${next}`
      return NextResponse.redirect(target)
    }

    console.error('[auth/callback] FAILED:', error.message, '| status:', error.status)
  }

  return NextResponse.redirect(
    `${base}/login?error=${encodeURIComponent('Authentication failed. Please try again.')}`,
  )
}
