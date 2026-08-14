/**
 * DiceBear adventurer-neutral base URL (v9 API).
 *
 * Shared by the client-side avatar hook (src/lib/useDiceBearUrl.ts) and the
 * server-side /api/avatar proxy so both produce identical avatars for the same
 * seed. This module must stay free of React imports: it is imported by the
 * server route, so any `useState`/`useEffect` here would break the RSC
 * boundary. The client hook lives in useDiceBearUrl.ts ("use client").
 */
export const DICEBEAR_BASE =
  'https://api.dicebear.com/9.x/adventurer-neutral/svg' +
  '?backgroundColor=ffd5dc,c0aede,b6e3f4,f2d3b1' +
  '&eyebrows=variant01,variant02,variant03,variant05,variant06,variant07,variant08,variant09,variant10,variant11,variant12,variant13,variant14,variant15' +
  '&mouth=variant01,variant02,variant03,variant04,variant09,variant10,variant11,variant12,variant13,variant14,variant15,variant16,variant17,variant18,variant19,variant21,variant22,variant23,variant24,variant25,variant26,variant27,variant28,variant29,variant30,variant20'

/**
 * Builds a DiceBear adventurer-neutral SVG avatar URL for a stable seed.
 *
 * The seed is hashed in the browser before being forwarded to
 * api.dicebear.com, so raw PII (email, display name) never leaves the client.
 * SHA-256 is used when the Web Crypto API is available; a synchronous FNV-1a
 * fallback keeps avatars working on non-secure contexts (LAN/IP HTTP), where
 * `crypto.subtle` is undefined and would otherwise leave the avatar blank.
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
  const hashedSeed = await hashSeedForAvatar(seed)
  return `${DICEBEAR_BASE}&seed=${hashedSeed}`
}

/**
 * SHA-256 hashes the avatar seed (PII-safe) with a synchronous fallback.
 *
 * `crypto.subtle` only exists in secure contexts (HTTPS / localhost). On
 * LAN/IP HTTP it is undefined, and where present it can reject. Rather than
 * letting the avatar stay null forever, both cases fall through to a
 * deterministic FNV-1a hex hash so the DiceBear URL still resolves.
 */
async function hashSeedForAvatar(seed: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(seed),
      )
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    } catch {
      // crypto.subtle rejected (non-secure context / browser policy) — fall
      // through to the synchronous hash below instead of hanging forever.
    }
  }
  return fallbackHexHash(seed)
}

/** FNV-1a 32-bit hex digest. Deterministic, synchronous, PII-safe. */
function fallbackHexHash(seed: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
