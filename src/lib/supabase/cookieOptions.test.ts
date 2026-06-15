import { describe, it, expect } from 'vitest'
import { resolveCookieDomain, buildCookieOptions } from './cookieOptions'

describe('resolveCookieDomain', () => {
  it('returns undefined when nothing is configured', () => {
    expect(resolveCookieDomain(undefined)).toBeUndefined()
  })

  it('returns undefined for an empty string', () => {
    expect(resolveCookieDomain('')).toBeUndefined()
  })

  it('returns undefined for a whitespace-only string', () => {
    expect(resolveCookieDomain('   ')).toBeUndefined()
  })

  it('returns the configured production domain', () => {
    expect(resolveCookieDomain('.worldwideview.dev')).toBe('.worldwideview.dev')
  })

  it('trims surrounding whitespace', () => {
    expect(resolveCookieDomain('  .wwv.local  ')).toBe('.wwv.local')
  })
})

describe('buildCookieOptions', () => {
  it('does not set httpOnly (client-side auth token needs JS access)', () => {
    expect(buildCookieOptions()).not.toHaveProperty('httpOnly')
  })

  it('sets secure: true (cross-subdomain cookies require HTTPS)', () => {
    expect(buildCookieOptions().secure).toBe(true)
  })

  it('sets sameSite: lax (allows cross-subdomain top-level navigation)', () => {
    expect(buildCookieOptions().sameSite).toBe('lax')
  })

  it('uses NEXT_PUBLIC_WWV_COOKIE_DOMAIN when set', () => {
    const original = process.env.NEXT_PUBLIC_WWV_COOKIE_DOMAIN
    process.env.NEXT_PUBLIC_WWV_COOKIE_DOMAIN = '.wwv.local'
    try {
      expect(buildCookieOptions().domain).toBe('.wwv.local')
    } finally {
      if (original === undefined) delete process.env.NEXT_PUBLIC_WWV_COOKIE_DOMAIN
      else process.env.NEXT_PUBLIC_WWV_COOKIE_DOMAIN = original
    }
  })
})
