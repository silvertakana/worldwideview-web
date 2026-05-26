import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { safeNext } from './safeNext'

describe('safeNext', () => {
  it('allows same-origin relative paths', () => {
    expect(safeNext('/accounts')).toBe('/accounts')
    expect(safeNext('/hub/billing')).toBe('/hub/billing')
    expect(safeNext('/')).toBe('/')
  })

  it('rejects absolute URLs to untrusted hosts (open redirect)', () => {
    expect(safeNext('https://evil.com')).toBe('/accounts')
    expect(safeNext('http://evil.com')).toBe('/accounts')
  })

  it('rejects protocol-relative URLs', () => {
    expect(safeNext('//evil.com')).toBe('/accounts')
  })

  it('rejects backslash-prefixed paths some browsers treat as protocol-relative', () => {
    expect(safeNext('/\\evil.com')).toBe('/accounts')
  })

  it('rejects scheme-like strings', () => {
    expect(safeNext('javascript:alert(1)')).toBe('/accounts')
  })

  it('rejects data: URLs', () => {
    expect(safeNext('data:text/html,<script>alert(1)</script>')).toBe('/accounts')
  })

  it('rejects double-slash paths that look like local paths', () => {
    // //accounts is parsed as protocol-relative by browsers, not a local path
    expect(safeNext('//accounts')).toBe('/accounts')
  })

  it('allows percent-encoded same-origin paths', () => {
    // Behavior is defined: same-origin percent-encoded paths are allowed as-is
    expect(safeNext('/foo%20bar')).toBe('/foo%20bar')
  })

  it('rejects null, undefined, and empty input', () => {
    expect(safeNext(null)).toBe('/accounts')
    expect(safeNext(undefined)).toBe('/accounts')
    expect(safeNext('')).toBe('/accounts')
  })

  describe('with NEXT_PUBLIC_WWV_COOKIE_DOMAIN set to .wwv.local', () => {
    const originalEnv = process.env.NEXT_PUBLIC_WWV_COOKIE_DOMAIN

    beforeEach(() => {
      process.env.NEXT_PUBLIC_WWV_COOKIE_DOMAIN = '.wwv.local'
    })

    afterEach(() => {
      if (originalEnv === undefined) delete process.env.NEXT_PUBLIC_WWV_COOKIE_DOMAIN
      else process.env.NEXT_PUBLIC_WWV_COOKIE_DOMAIN = originalEnv
    })

    it('allows trusted sibling subdomains', () => {
      expect(safeNext('https://marketplace.wwv.local:3002/plugins/abc')).toBe(
        'https://marketplace.wwv.local:3002/plugins/abc',
      )
      expect(safeNext('http://app.wwv.local:3000/dashboard')).toBe(
        'http://app.wwv.local:3000/dashboard',
      )
      expect(safeNext('https://wwv.local')).toBe('https://wwv.local/')
    })

    it('still rejects non-sibling hosts that merely contain the cookie domain string', () => {
      expect(safeNext('https://wwv.local.evil.com')).toBe('/accounts')
      expect(safeNext('https://evilwwv.local')).toBe('/accounts')
    })
  })
})
