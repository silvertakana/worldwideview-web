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
    // Pin an explicit cookie name so the browser and server always
    // read/write the same session cookie, regardless of Supabase URL
    // hostname differences (CI: 127.0.0.1 vs host.docker.internal).
    // @supabase/ssr maps cookieOptions.name → supabase-js auth.storageKey,
    // which determines the actual cookie name (chunked as <name>,
    // <name>.0, …).
    name: 'wwv-hub-auth-token',
    domain: resolveCookieDomain(process.env.NEXT_PUBLIC_WWV_COOKIE_DOMAIN),
    path: '/',
    sameSite: 'lax' as const,
    secure: true,
    // httpOnly is intentionally OFF so the client-side createBrowserClient
    // can read the wwv-hub-auth-token cookie via document.cookie and restore
    // the session on page load. The server-side client (middleware, server.ts)
    // reads the cookie from the request object directly, not via JS, so it
    // is unaffected by this setting.
  }
}
