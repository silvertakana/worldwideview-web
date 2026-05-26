import { createHash } from 'crypto'
import { NextResponse } from 'next/server'

const DICEBEAR_BASE =
  'https://api.dicebear.com/9.x/adventurer-neutral/svg' +
  '?backgroundColor=ffd5dc,c0aede,b6e3f4,f2d3b1' +
  '&eyebrows=variant01,variant02,variant03,variant05,variant06,variant07,variant08,variant09,variant10,variant11,variant12,variant13,variant14,variant15' +
  '&mouth=variant01,variant02,variant03,variant04,variant09,variant10,variant11,variant12,variant13,variant14,variant15,variant16,variant17,variant18,variant19,variant21,variant22,variant23,variant24,variant25,variant26,variant27,variant28,variant29,variant30,variant20'

/**
 * GET /api/avatar?seed=<string>
 *
 * Server-side DiceBear proxy. SHA-256 hashes the incoming seed so that raw
 * PII (email, display name) is never forwarded to api.dicebear.com.
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
