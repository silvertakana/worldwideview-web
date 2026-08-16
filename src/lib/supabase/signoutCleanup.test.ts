import { describe, it, expect } from 'vitest'
import {
  SESSION_COOKIE_BASE_NAMES,
  isSessionCookieName,
  buildSignoutExpiryCookies,
  clearSignoutCookiesClient,
} from './signoutCleanup'

const PINNED = 'wwv-hub-auth-token'
const LEGACY = 'sb-kvlnzjtcstnaqkpqrquf-auth-token'

describe('SESSION_COOKIE_BASE_NAMES', () => {
  it('covers the pinned hub name and the legacy/marketplace default name', () => {
    expect(SESSION_COOKIE_BASE_NAMES).toContain(PINNED)
    expect(SESSION_COOKIE_BASE_NAMES).toContain(LEGACY)
  })
})

describe('isSessionCookieName', () => {
  it('matches both base names exactly', () => {
    expect(isSessionCookieName(PINNED)).toBe(true)
    expect(isSessionCookieName(LEGACY)).toBe(true)
  })

  it('matches chunk suffixes of both base names', () => {
    expect(isSessionCookieName(`${PINNED}.0`)).toBe(true)
    expect(isSessionCookieName(`${PINNED}.1`)).toBe(true)
    expect(isSessionCookieName(`${LEGACY}.0`)).toBe(true)
    expect(isSessionCookieName(`${LEGACY}.3`)).toBe(true)
  })

  it('matches chunk indices beyond the @supabase/ssr 5-chunk boundary', () => {
    expect(isSessionCookieName(`${PINNED}.15`)).toBe(true)
    expect(isSessionCookieName(`${LEGACY}.20`)).toBe(true)
  })

  it('rejects unrelated cookies', () => {
    expect(isSessionCookieName('other-cookie')).toBe(false)
    expect(isSessionCookieName('sb-other-project-auth-token')).toBe(false)
    expect(isSessionCookieName('wwv-hub-auth-token-extra')).toBe(false)
    expect(isSessionCookieName(`${LEGACY}-suffix`)).toBe(false)
  })
})

describe('buildSignoutExpiryCookies', () => {
  it('expires every chunk of both session names and nothing else', () => {
    const names = [
      PINNED,
      `${PINNED}.0`,
      `${PINNED}.1`,
      LEGACY,
      `${LEGACY}.0`,
      'other-cookie',
    ]
    const expiry = buildSignoutExpiryCookies(names)
    const cleared = expiry.map((c) => c.name)
    expect(cleared).toEqual([
      PINNED,
      `${PINNED}.0`,
      `${PINNED}.1`,
      LEGACY,
      `${LEGACY}.0`,
    ])
    expect(cleared).not.toContain('other-cookie')
  })

  it('returns an empty list when no cookies are present', () => {
    expect(buildSignoutExpiryCookies([])).toEqual([])
  })

  it('returns an empty list when only unrelated cookies are present', () => {
    expect(buildSignoutExpiryCookies(['other-cookie', 'analytics'])).toEqual([])
  })

  it('clears legacy-only jars (pre-pin orphans)', () => {
    const expiry = buildSignoutExpiryCookies([LEGACY, `${LEGACY}.1`])
    expect(expiry.map((c) => c.name)).toEqual([LEGACY, `${LEGACY}.1`])
  })

  it('clears pinned-only jars', () => {
    const expiry = buildSignoutExpiryCookies([PINNED, `${PINNED}.0`])
    expect(expiry.map((c) => c.name)).toEqual([PINNED, `${PINNED}.0`])
  })

  it('handles a high sparse chunk index present in the request', () => {
    const expiry = buildSignoutExpiryCookies([`${LEGACY}.18`])
    expect(expiry).toHaveLength(1)
    expect(expiry[0].name).toBe(`${LEGACY}.18`)
  })

  it('builds expired cookie descriptors (empty value, maxAge 0, past expiry)', () => {
    const [cookie] = buildSignoutExpiryCookies([PINNED])
    expect(cookie.value).toBe('')
    expect(cookie.options.maxAge).toBe(0)
    expect(cookie.options.path).toBe('/')
    expect(cookie.options.sameSite).toBe('lax')
    expect(cookie.options.secure).toBe(true)
    expect(cookie.options.expires.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('propagates the parent domain so deletion matches the original cookie', () => {
    const [cookie] = buildSignoutExpiryCookies([PINNED], '.wwv.local')
    expect(cookie.options.domain).toBe('.wwv.local')
  })

  it('omits the domain attribute when no domain is configured', () => {
    const [cookie] = buildSignoutExpiryCookies([PINNED])
    expect(cookie.options).not.toHaveProperty('domain')
  })
})

describe('clearSignoutCookiesClient', () => {
  it('expires all document.cookie entries of both session names', () => {
    document.cookie = `${PINNED}=abc; path=/`
    document.cookie = `${PINNED}.0=def; path=/`
    document.cookie = `${LEGACY}=ghi; path=/`
    document.cookie = 'other-cookie=keep; path=/'

    clearSignoutCookiesClient()

    expect(document.cookie).toContain('other-cookie=keep')
    expect(document.cookie).not.toContain(`${PINNED}=`)
    expect(document.cookie).not.toContain(`${PINNED}.0=`)
    expect(document.cookie).not.toContain(`${LEGACY}=`)
  })
})
