import { describe, it, expect } from 'vitest'
import { safeNext } from './safeNext'

describe('safeNext', () => {
  it('allows same-origin relative paths', () => {
    expect(safeNext('/accounts')).toBe('/accounts')
    expect(safeNext('/hub/billing')).toBe('/hub/billing')
    expect(safeNext('/')).toBe('/')
  })

  it('rejects absolute URLs (open redirect)', () => {
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

  it('rejects null, undefined, and empty input', () => {
    expect(safeNext(null)).toBe('/accounts')
    expect(safeNext(undefined)).toBe('/accounts')
    expect(safeNext('')).toBe('/accounts')
  })
})
