import { createHash } from 'crypto'
import { NextResponse } from 'next/server'
import { DICEBEAR_BASE } from '@/lib/diceBear'

/**
 * GET /api/avatar?seed=<string>
 *
 * Server-side DiceBear proxy. SHA-256 hashes the incoming seed so that raw
 * PII (email, display name) is never forwarded to api.dicebear.com.
 *
 * The UI renders DiceBear avatars directly in the browser (see
 * src/lib/diceBear.ts), so this route is a compatibility/fallback endpoint:
 * it works wherever the server can reach api.dicebear.com.
 *
 * - seed: URL-encoded seed string (required)
 * - Returns: SVG image with 24-hour public cache
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const seed = searchParams.get('seed')

  if (!seed) {
    return new NextResponse('seed is required', { status: 400 })
  }

  const hashedSeed = createHash('sha256').update(seed).digest('hex')
  const diceBearUrl = `${DICEBEAR_BASE}&seed=${hashedSeed}`

  let svgText: string
  try {
    const upstream = await fetch(diceBearUrl)
    if (!upstream.ok) {
      return new NextResponse('upstream error', { status: 502 })
    }
    svgText = await upstream.text()
  } catch {
    return new NextResponse('upstream error', { status: 502 })
  }

  return new NextResponse(svgText, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400',
    },
  })
}
