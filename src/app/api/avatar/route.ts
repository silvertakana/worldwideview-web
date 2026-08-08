import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { canonicalAvatarState, normalizeEmailSeed } from '@/lib/avatar'
import { generateAvatarSvg } from '@/lib/avatarSvg'

/**
 * GET /api/avatar
 *
 * Session-authenticated canonical avatar endpoint. Every avatar surface
 * (Header, accounts page) renders from this same-origin URL, so avatars can
 * never diverge; the custom-URL / canonical-URL decision lives in
 * src/lib/avatar.ts (canonicalAvatarState).
 *
 * - No session -> 401.
 * - Custom `avatar_url` http/https -> 307 redirect, no-store cache.
 * - Custom `avatar_url` data: -> served INLINE (browsers do not reliably
 *   follow 307 redirects to data: URLs), immutable cache.
 * - Otherwise -> DiceBear SVG generated OFFLINE in-process from the SHA-256
 *   hashed email seed (src/lib/avatarSvg.ts). No network call, no timeout,
 *   no upstream-failure path: generation cannot fail on the network.
 *
 * No ?email= / ?userId= / ?seed= params are accepted: identity comes solely
 * from the session cookie.
 */
export async function GET(): Promise<NextResponse> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { customUrl } = canonicalAvatarState(user)

  if (customUrl) {
    if (customUrl.startsWith('data:')) {
      return new NextResponse(customUrl, {
        status: 200,
        headers: {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'public, max-age=86400, immutable',
        },
      })
    }
    return new NextResponse(null, {
      status: 307,
      headers: {
        Location: customUrl,
        'Cache-Control': 'no-store',
      },
    })
  }

  // Normalized (trimmed, lowercased) email seeds the face; generateAvatarSvg
  // hashes it with SHA-256 before rendering, so the raw email never appears
  // in the SVG output.
  const svgText = await generateAvatarSvg(normalizeEmailSeed(user.email))

  return new NextResponse(svgText, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  })
}
