/**
 * Deterministic client-side avatar fallback: a colored circle with initials.
 *
 * Used when the primary avatar source fails to load (stale storage URL,
 * DiceBear proxy 502, network block, deleted OAuth image). Zero external
 * dependencies -- the SVG is generated inline and returned as a data URL,
 * so it can never fail to load the way a network image can.
 *
 * Determinism: the same seed always yields the same background color and
 * the same initials, so a given user sees a stable avatar across reloads.
 *
 * @param seed - Stable string (email, user id, display name) used to derive
 *   a consistent avatar for the same identity.
 * @returns `data:image/svg+xml;utf8,...` URL that renders immediately.
 */
export function avatarFallbackDataUrl(seed: string): string {
  const color = PALETTE[hashString(seed) % PALETTE.length]
  const initials = initialsOf(seed)
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" ' +
    'viewBox="0 0 200 200"><rect width="200" height="200" fill="' +
    color +
    '"/><text x="100" y="100" font-family="Arial, sans-serif" font-size="72" ' +
    'font-weight="700" fill="#ffffff" text-anchor="middle" ' +
    'dominant-baseline="central">' +
    initials +
    '</text></svg>'
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const PALETTE = [
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#f59e0b',
  '#10b981',
  '#06b6d4',
  '#f43f5e',
  '#84cc16',
]

function hashString(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

export function initialsOf(seed: string): string {
  const words = seed.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase()
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase()
  }
  return '?'
}

/**
 * Resolves the best available display name from Supabase user metadata.
 *
 * The app historically reads `user_metadata.display_name`, but Supabase
 * email signup stores the signup name under `user_metadata.name` and OAuth
 * providers populate `full_name`. Reading all three keeps the name visible
 * to the avatar + display logic regardless of which key the identity
 * provider wrote.
 *
 * Empty/whitespace-only values count as unset, so a cleared display_name
 * falls through to `name` / `full_name`.
 *
 * @param metadata - `user.user_metadata` (or null/undefined).
 * @returns The first present non-empty name, or null when none exists.
 */
export function resolveDisplayName(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const candidates = [
    metadata?.display_name,
    metadata?.name,
    metadata?.full_name,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate
    }
  }
  return null
}
