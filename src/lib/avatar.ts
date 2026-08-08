/**
 * Shared avatar state resolver for the hub.
 *
 * Both avatar surfaces (Header + accounts page) import this module so they
 * can never diverge. The design decision: avatars seed from EMAIL, not the
 * display name, because email is stable across name changes -- renaming
 * yourself must not re-randomize your DiceBear face.
 *
 * The browser only ever talks to the same-origin `/api/avatar` endpoint.
 * DiceBear is contacted server-side by that route, never directly from the
 * client, so the custom-URL / canonical-URL decision below is the single
 * source of truth for every avatar render.
 */

/**
 * Normalizes an email into a stable avatar seed: trimmed and lowercased.
 *
 * Nullish input yields an empty string so downstream consumers never have
 * to guard against undefined seeds.
 *
 * @param email - The user's email (may be null/undefined for anonymous users).
 * @returns Lowercased, trimmed email, or '' for nullish input.
 */
export function normalizeEmailSeed(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase()
}

/**
 * Resolves the canonical avatar render state for a user.
 *
 * The canonical URL is always the same-origin `/api/avatar` endpoint; the
 * browser must never reach external avatar providers directly. A user-set
 * `avatar_url` (http/https/data:) short-circuits rendering to that custom
 * image; otherwise the seed drives the server-side DiceBear generation.
 *
 * @param user - Supabase user (or null when unauthenticated).
 * @returns `canonicalUrl` (always `/api/avatar`), `customUrl` (the user's
 *   avatar_url when it is a valid http/https/data: string, else null), and
 *   `seed` (normalized email, stable across display-name changes).
 */
export function canonicalAvatarState(
  user: {
    email?: string | null
    user_metadata?: Record<string, unknown>
  } | null,
): { canonicalUrl: string; customUrl: string | null; seed: string } {
  const seed = normalizeEmailSeed(user?.email)
  const customUrl = customAvatarUrl(user?.user_metadata)
  return { canonicalUrl: '/api/avatar', customUrl, seed }
}

/**
 * Reads the user's custom avatar URL from Supabase user metadata.
 *
 * Only http://, https://, and data: URLs are accepted; everything else
 * (missing, non-string, empty, relative paths) resolves to null so the
 * canonical same-origin avatar is used instead.
 *
 * @param metadata - `user.user_metadata` (or null/undefined).
 * @returns The custom avatar URL, or null when absent or invalid.
 */
function customAvatarUrl(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const candidate = metadata?.avatar_url
  if (
    typeof candidate === 'string' &&
    (candidate.startsWith('http://') ||
      candidate.startsWith('https://') ||
      candidate.startsWith('data:'))
  ) {
    return candidate
  }
  return null
}
