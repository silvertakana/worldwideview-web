/**
 * Signout cookie cleanup for the shared cross-subdomain cookie jar
 * (`.wwv.local` in dev, `.worldwideview.dev` in production — ADR-003D).
 *
 * Why both base names? The hub pins its session cookie name to
 * `wwv-hub-auth-token` (see cookieOptions.ts), but the app historically used
 * Supabase's default project-ref-derived name `sb-<project-ref>-auth-token`
 * before the pin migration (commit e71ef30) — and the marketplace still uses
 * that default name today, on the same Supabase project and the same parent
 * domain. `supabase.auth.signOut()` only removes the storage-key chunks of the
 * current name, so legacy/marketplace chunks survive signout and accumulate on
 * the shared jar until the Cookie header blows past Node's 16KB max header
 * size (HTTP 431). This module expires every chunk of BOTH names.
 */

import { resolveCookieDomain } from './cookieOptions'

export const SESSION_COOKIE_BASE_NAMES = [
  'wwv-hub-auth-token',
  'sb-kvlnzjtcstnaqkpqrquf-auth-token',
] as const

export interface SignoutExpiryCookie {
  name: string
  value: string
  options: {
    path: string
    domain?: string
    maxAge: number
    expires: Date
    sameSite: 'lax'
    secure: boolean
  }
}

/** True when the cookie name is one of the session bases or one of its
 * @supabase/ssr chunks (`<base>`, `<base>.0`, `<base>.1`, ...). */
export function isSessionCookieName(name: string): boolean {
  return SESSION_COOKIE_BASE_NAMES.some(
    (base) => name === base || name.startsWith(`${base}.`),
  )
}

/**
 * Pure helper: given the cookie names present in a request, return an expiry
 * entry (value '' + Max-Age=0) for every session cookie chunk of both base
 * names. Unrelated cookies are never touched. The `domain` (if any) must match
 * how the session cookies were originally set so the browser can delete them.
 */
export function buildSignoutExpiryCookies(
  cookieNames: readonly string[],
  domain?: string,
): SignoutExpiryCookie[] {
  return cookieNames.filter(isSessionCookieName).map((name) => ({
    name,
    value: '',
    options: {
      path: '/',
      ...(domain ? { domain } : {}),
      maxAge: 0,
      expires: new Date(0),
      sameSite: 'lax',
      secure: true,
    },
  }))
}

/**
 * Client-side cleanup: expire every document.cookie entry that belongs to
 * either session base name. Called from the Header signout handler because
 * the browser-side `supabase.auth.signOut()` only clears its own storage-key
 * chunks. The domain attribute must mirror how the cookies were set.
 */
export function clearSignoutCookiesClient(domain?: string): void {
  if (typeof document === 'undefined') return
  const domainAttr = domain ? `domain=${domain}; ` : ''
  for (const entry of document.cookie.split(';')) {
    const name = entry.split('=')[0]?.trim()
    if (name && isSessionCookieName(name)) {
      document.cookie = `${name}=; ${domainAttr}Max-Age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/;`
    }
  }
}

/** Resolves the cookie domain exactly like buildCookieOptions does, so the
 * cleanup always matches the live cookie settings. */
export function resolveSignoutDomain(): string | undefined {
  return resolveCookieDomain(process.env.NEXT_PUBLIC_WWV_COOKIE_DOMAIN)
}
