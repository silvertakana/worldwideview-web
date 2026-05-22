import { describe, it, expect } from 'vitest'
import { resolveCookieDomain } from './cookieOptions'

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
