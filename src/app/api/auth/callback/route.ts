import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { safeNext } from '../../../../lib/safeNext'

/**
 * Handles the redirect back from an OAuth provider (Google/GitHub) and from
 * the email-confirmation link. Exchanges the one-time `code` for a session.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = safeNext(searchParams.get('next'))
  const base = process.env.NEXT_PUBLIC_SITE_URL || origin

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${base}${next}`)
    }
  }

  return NextResponse.redirect(
    `${base}/login?error=${encodeURIComponent('Authentication failed. Please try again.')}`,
  )
}
