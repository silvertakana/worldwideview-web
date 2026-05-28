/**
 * Sanitises a post-auth `next` redirect target.
 *
 * Allows:
 *   1. Same-origin relative paths like `/foo/bar`
 *   2. Absolute URLs whose hostname ends with NEXT_PUBLIC_WWV_COOKIE_DOMAIN
 *      (e.g. `https://marketplace.wwv.local:3002/...` when cookie domain is
 *      `.wwv.local`). This lets the auth host bounce users back to whichever
 *      sibling subdomain initiated the login (marketplace, app, etc.) without
 *      opening a generic open-redirect vulnerability.
 *
 * Everything else falls back to `/accounts`.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return '/accounts'

  // A bare "/" (or any path that is only slashes) is not a useful destination:
  // it would land the user on the auth host's marketing root after login,
  // not on their intended page. Treat it like the empty-string case.
  if (/^\/+$/.test(raw)) return '/accounts'

  if (raw.startsWith('/') && raw[1] !== '/' && raw[1] !== '\\') {
    return raw
  }

  const cookieDomain = process.env.NEXT_PUBLIC_WWV_COOKIE_DOMAIN
  if (cookieDomain) {
    try {
      const url = new URL(raw)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        const normalised = cookieDomain.startsWith('.') ? cookieDomain : `.${cookieDomain}`
        const hostWithDot = `.${url.hostname}`
        if (hostWithDot.endsWith(normalised)) {
          return url.toString()
        }
      }
    } catch {
      // fall through to default
    }
  }

  return '/accounts'
}
