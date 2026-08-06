import { useEffect, useState } from 'react'

/**
 * DiceBear adventurer-neutral base URL (v9 API).
 *
 * Shared by the client-side avatar renderer (this module) and the server-side
 * /api/avatar proxy so both produce identical avatars for the same seed.
 */
export const DICEBEAR_BASE =
  'https://api.dicebear.com/9.x/adventurer-neutral/svg' +
  '?backgroundColor=ffd5dc,c0aede,b6e3f4,f2d3b1' +
  '&eyebrows=variant01,variant02,variant03,variant05,variant06,variant07,variant08,variant09,variant10,variant11,variant12,variant13,variant14,variant15' +
  '&mouth=variant01,variant02,variant03,variant04,variant09,variant10,variant11,variant12,variant13,variant14,variant15,variant16,variant17,variant18,variant19,variant21,variant22,variant23,variant24,variant25,variant26,variant27,variant28,variant29,variant30,variant20'

/**
 * Builds a DiceBear adventurer-neutral SVG avatar URL for a stable seed.
 *
 * The seed is SHA-256 hashed in the browser before being forwarded to
 * api.dicebear.com, so raw PII (email, display name) never leaves the client.
 *
 * The avatar is loaded directly by the browser instead of via the server-side
 * /api/avatar proxy because server containers may not be able to reach
 * api.dicebear.com (e.g. Docker NAT paths to DiceBear's CDN edge), while the
 * client's own network can.
 *
 * @param seed - A stable string (email, avatar_url, display name) used to
 *   derive a consistent avatar appearance for the same identity.
 * @returns A promise resolving to a direct api.dicebear.com SVG URL.
 */
export async function diceBearUrl(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(seed),
  )
  const hashedSeed = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `${DICEBEAR_BASE}&seed=${hashedSeed}`
}

/**
 * Resolves a DiceBear avatar URL for the given seed.
 *
 * Returns null until the async hash + URL build completes, so callers can
 * render a placeholder instead of a broken image.
 *
 * @param seed - Stable identity string, or null to clear the avatar URL.
 */
export function useDiceBearUrl(seed: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!seed) {
      setUrl(null)
      return
    }
    let cancelled = false
    diceBearUrl(seed).then((u) => {
      if (!cancelled) setUrl(u)
    })
    return () => {
      cancelled = true
    }
  }, [seed])

  return url
}
