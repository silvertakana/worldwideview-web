/**
 * Cross-subdomain session cookies (ADR-003D).
 *
 * The cookie `domain` must be `.worldwideview.dev` in production and `.wwv.local`
 * in local dev so every subdomain inherits the Supabase session. When no domain
 * is configured the attribute is omitted entirely — browsers reject an explicit
 * `domain` on a bare `localhost` host.
 */
export function resolveCookieDomain(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim()
  return trimmed ? trimmed : undefined
}

export function buildCookieOptions() {
  return {
    domain: resolveCookieDomain(process.env.NEXT_PUBLIC_WWV_COOKIE_DOMAIN),
    path: '/',
    sameSite: 'lax' as const,
    secure: true,
    // httpOnly closes the XSS-exfiltration vector: document.cookie can no longer
    // read the sb-...-auth-token blob. The Supabase browser client falls back to
    // a network call when cookies are unreadable, which is the supported pattern
    // — all read paths in this app are server-side anyway (see hub/layout.tsx,
    // accounts/page.tsx). Marketplace already runs with httpOnly: true.
    httpOnly: true,
  }
}
