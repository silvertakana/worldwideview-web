/**
 * Sanitises a post-auth `next` redirect target. Only same-origin relative
 * paths are allowed — anything else (absolute URL, protocol-relative `//`,
 * backslash trick, custom scheme) falls back to `/accounts` to prevent an
 * open-redirect vulnerability.
 */
export function safeNext(raw: string | null | undefined): string {
  if (raw && raw.startsWith('/') && raw[1] !== '/' && raw[1] !== '\\') {
    return raw
  }
  return '/accounts'
}
