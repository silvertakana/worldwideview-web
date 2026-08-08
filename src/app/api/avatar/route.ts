import { createHash } from 'crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { canonicalAvatarState } from '@/lib/avatar'
import { DICEBEAR_BASE } from '@/lib/diceBear'

/**
 * GET /api/avatar
 *
 * Session-authenticated canonical avatar endpoint. Every avatar surface
 * (Header, accounts page) renders from this same-origin URL, so avatars can
 * never diverge; the custom-URL / canonical-URL decision lives in
 * src/lib/avatar.ts (canonicalAvatarState).
 *
 * - No session -> 401.
 * - Custom `avatar_url` (http/https/data:) -> 307 redirect, no-store cache.
 * - Otherwise -> server-side DiceBear SVG proxy. The email seed is SHA-256
 *   hashed before being forwarded as &seed=, so api.dicebear.com never sees
 *   raw PII. Responses carry a 24h immutable public cache.
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

  const { customUrl, seed } = canonicalAvatarState(user)

  if (customUrl) {
    return new NextResponse(null, {
      status: 307,
      headers: {
        Location: customUrl,
        'Cache-Control': 'no-store',
      },
    })
  }

  // seed is the normalized (trimmed, lowercased) email from
  // canonicalAvatarState. Hash it so the upstream provider only ever sees a
  // digest, never the raw email.
  const hashedSeed = createHash('sha256').update(seed).digest('hex')
  const diceBearUrl = `${DICEBEAR_BASE}&seed=${hashedSeed}`

  let svgText: string
  try {
    const upstream = await fetch(diceBearUrl)
    if (!upstream.ok) {
      return NextResponse.json(
        { error: 'Upstream avatar provider failed' },
        { status: 502 },
      )
    }
    svgText = await upstream.text()
  } catch {
    return NextResponse.json(
      { error: 'Upstream avatar provider failed' },
      { status: 502 },
    )
  }

  return new NextResponse(svgText, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  })
}
