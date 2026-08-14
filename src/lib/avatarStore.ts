/**
 * Avatar store-once + provenance helpers for the hub.
 *
 * Every write site that stores an avatar URL into `user_metadata` also stamps
 * `avatar_source` so "where did this avatar come from" stays answerable:
 *
 *   - 'google' | 'github'  OAuth provider avatar copied by Supabase at signup
 *   - 'upload'             user-uploaded image stored in Supabase Storage
 *   - 'dicebear'           deterministic offline-generated face (email seed)
 *
 * The I/O helpers are deliberately dependency-free (no Supabase imports, no
 * `server-only`): call sites create and pass in their own client (admin client
 * for the no-session signup write, session client for the OAuth callback),
 * which keeps this module unit-testable with plain mock clients.
 */

import { generateAvatarSvg } from './avatarSvg'
import { normalizeEmailSeed } from './avatar'

export const AVATAR_SOURCE_DICEBEAR = 'dicebear'
export const AVATAR_SOURCE_GOOGLE = 'google'
export const AVATAR_SOURCE_GITHUB = 'github'
export const AVATAR_SOURCE_UPLOAD = 'upload'

export type AvatarSource = 'google' | 'github' | 'upload' | 'dicebear'

/** Minimal structural view of the user object the helpers read. */
interface AvatarUser {
  id: string
  email?: string | null
  user_metadata?: Record<string, unknown>
}

/** Minimal structural view of the admin (service-role) client. */
export interface AdminAvatarClient {
  auth: {
    admin: {
      getUserById: (userId: string) => Promise<{
        data: { user: AvatarUser | null }
        error: { message: string } | null
      }>
      updateUserById: (
        userId: string,
        attributes: { user_metadata: Record<string, unknown> },
      ) => Promise<{ error: { message: string } | null }>
    }
  }
}

/** Minimal structural view of a session-authenticated client. */
export interface SessionAvatarClient {
  auth: {
    updateUser: (attributes: { data: Record<string, unknown> }) => Promise<{
      error: { message: string } | null
    }>
  }
}

/**
 * Encodes an SVG document as a data URL suitable for storing in
 * `user_metadata.avatar_url`.
 *
 * @param svg - The raw SVG document string.
 * @returns A `data:image/svg+xml;utf8,...` URL.
 */
export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/**
 * Extracts and decodes the payload of a stored data-URL avatar.
 *
 * Inverse of `svgToDataUrl`: given the `data:image/svg+xml;utf8,<encoded>`
 * URLs the store writes, returns the decoded SVG document. Returns null when
 * the input is not a usable data URL (wrong prefix, missing `;` media
 * parameter, empty payload, un-decodable encoding, or a payload that is not
 * an SVG document) so callers can fall back to offline generation instead of
 * serving the raw data-URL string as an image body.
 *
 * @param dataUrl - A stored `avatar_url` value beginning with `data:`.
 * @returns The decoded SVG document, or null when malformed.
 */
export function extractDataUrlPayload(dataUrl: string): string | null {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    return null
  }
  const commaIndex = dataUrl.indexOf(',')
  // Require the `data:<media>;<encoding>,<payload>` shape; a comma-less or
  // media-parameter-less URL (e.g. bare `data:,payload`) is not an avatar.
  if (commaIndex === -1 || !dataUrl.slice(0, commaIndex).includes(';')) {
    return null
  }
  const payload = dataUrl.slice(commaIndex + 1)
  if (payload === '') {
    return null
  }
  try {
    const decoded = decodeURIComponent(payload)
    // The payload must actually be an SVG document, not decodable garbage.
    if (!decoded.trimStart().startsWith('<svg')) {
      return null
    }
    return decoded
  } catch {
    return null
  }
}

/**
 * Maps a Supabase auth provider id to the avatar provenance label.
 *
 * Only OAuth providers that supply an avatar image are recognized; email and
 * unknown providers yield null so no provenance is ever invented.
 *
 * @param provider - `user.app_metadata.provider` (or an identity provider id).
 * @returns 'google' | 'github' for known OAuth providers, else null.
 */
export function avatarSourceForProvider(
  provider: string | null | undefined,
): AvatarSource | null {
  if (provider === 'google' || provider === 'github') {
    return provider
  }
  return null
}

/**
 * Decides whether a user still needs a DiceBear avatar stamped at signup.
 *
 * True when the user has no usable `avatar_url` yet -- a user created via
 * OAuth already has the provider's avatar and must be left untouched.
 *
 * @param metadata - `user.user_metadata`.
 * @returns True when a DiceBear avatar should be stored.
 */
export function shouldStoreDicebearAvatar(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  const existing = metadata?.avatar_url
  return typeof existing !== 'string' || existing.trim() === ''
}

/**
 * Decides whether an OAuth avatar_source label should be written for a user.
 *
 * Writes only when the user actually has an OAuth-supplied avatar_url and no
 * provenance label has been recorded yet -- the write is idempotent.
 *
 * @param metadata - `user.user_metadata`.
 * @param source - The candidate provenance label (may be null).
 * @returns True when the source should be written.
 */
export function shouldWriteAvatarSource(
  metadata: Record<string, unknown> | null | undefined,
  source: AvatarSource | null | undefined,
): boolean {
  if (!source) {
    return false
  }
  const existing = metadata?.avatar_url
  if (typeof existing !== 'string' || existing.trim() === '') {
    return false
  }
  return !metadata?.avatar_source
}

/**
 * Renders the deterministic DiceBear avatar for an email and encodes it as a
 * data URL, ready for `user_metadata.avatar_url`.
 *
 * @param email - The user's email (used as the stable seed).
 * @returns A `data:image/svg+xml;utf8,...` URL of the offline-generated SVG.
 */
export async function buildDicebearAvatarDataUrl(
  email: string | null | undefined,
): Promise<string> {
  const svg = await generateAvatarSvg(normalizeEmailSeed(email))
  return svgToDataUrl(svg)
}

/**
 * Best-effort store-once: stamps a DiceBear avatar onto a freshly created
 * user's metadata (avatar_url + avatar_source: 'dicebear').
 *
 * Skips users that already have an avatar_url and swallows every failure so a
 * broken avatar write can never fail the signup flow. Requires the admin
 * client because email-signup users have no session yet.
 *
 * @param client - Admin (service-role) client, created by the caller.
 * @param userId - The newly created user's id.
 * @param email - The user's email, used as the avatar seed.
 */
export async function storeDicebearAvatarAtSignup(
  client: AdminAvatarClient,
  userId: string,
  email: string | null | undefined,
): Promise<void> {
  try {
    const { data, error } = await client.auth.admin.getUserById(userId)
    if (error || !data.user) {
      return
    }
    if (!shouldStoreDicebearAvatar(data.user.user_metadata)) {
      return
    }
    const avatarUrl = await buildDicebearAvatarDataUrl(email)
    const userMetadata = {
      ...(data.user.user_metadata ?? {}),
      avatar_url: avatarUrl,
      avatar_source: AVATAR_SOURCE_DICEBEAR,
    }
    await client.auth.admin.updateUserById(userId, { user_metadata: userMetadata })
  } catch (err) {
    console.error('[avatarStore] failed to store dicebear avatar at signup:', err)
  }
}

/**
 * Best-effort provenance write for OAuth avatars.
 *
 * Supabase copies the provider's avatar_url into user_metadata automatically
 * at OAuth signup; this records which provider supplied it. Idempotent (skips
 * users that already have avatar_source) and never throws.
 *
 * @param client - Session-authenticated client.
 * @param user - The user read from the session.
 * @param source - 'google' | 'github' (or null to no-op).
 */
export async function writeOAuthAvatarSource(
  client: SessionAvatarClient,
  user: { user_metadata?: Record<string, unknown> } | null | undefined,
  source: AvatarSource | null,
): Promise<void> {
  try {
    if (!user || !shouldWriteAvatarSource(user.user_metadata, source)) {
      return
    }
    await client.auth.updateUser({ data: { avatar_source: source } })
  } catch (err) {
    console.error('[avatarStore] failed to write oauth avatar source:', err)
  }
}
