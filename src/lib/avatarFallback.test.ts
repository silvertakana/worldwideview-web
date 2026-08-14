import { describe, it, expect } from 'vitest'
import {
  avatarFallbackDataUrl,
  initialsOf,
  resolveDisplayName,
} from './avatarFallback'

// The UUID below is the real test user id from the 2026-08-08 investigation
// ("Quick Verify Tester", quickverify@worldwideview.local). It documents the
// old regression: commit 14a5342 passed user.id as the initials seed, which
// produced "4B" instead of "QV".
const TEST_USER_ID = '41332691-b37e-4bea-b82d-daf0e4fba48d'

function svgTextOf(dataUrl: string): string {
  const svg = decodeURIComponent(dataUrl.replace('data:image/svg+xml;utf8,', ''))
  const match = svg.match(/>([^<]+?)<\/text>/)
  return match ? match[1] : ''
}

describe('initialsOf', () => {
  it('uses the first letters of the first two words for multi-word names', () => {
    expect(initialsOf('Quick Verify Tester')).toBe('QV')
    expect(initialsOf('Jane Doe')).toBe('JD')
  })

  it('uses the first two characters of a single-word name', () => {
    expect(initialsOf('John')).toBe('JO')
    expect(initialsOf('alice')).toBe('AL')
  })

  it('derives initials from an email address (documented behavior)', () => {
    expect(initialsOf('quickverify@worldwideview.local')).toBe('QW')
  })

  it('returns "?" for empty or whitespace-only seeds', () => {
    expect(initialsOf('')).toBe('?')
    expect(initialsOf('   ')).toBe('?')
  })

  it('pins the old UUID/user.id seed bug: a UUID yields hex-derived initials', () => {
    // Regression pin: the header previously passed user.id as the fallback
    // seed, and initialsOf("41332691-...") == "4B". The fix makes callers
    // pass the resolved display name instead, so this exact output should
    // never appear for a user who has a name.
    expect(initialsOf(TEST_USER_ID)).toBe('4B')
  })

  it('treats non-alphanumeric separators as word boundaries', () => {
    expect(initialsOf('John--Doe__Smith')).toBe('JD')
    expect(initialsOf('!@#$')).toBe('?')
  })
})

describe('avatarFallbackDataUrl', () => {
  it('is deterministic for the same seed', () => {
    expect(avatarFallbackDataUrl('Quick Verify Tester')).toBe(
      avatarFallbackDataUrl('Quick Verify Tester'),
    )
  })

  it('embeds the expected initials in the SVG data URL', () => {
    expect(svgTextOf(avatarFallbackDataUrl('Quick Verify Tester'))).toBe('QV')
  })
})

describe('resolveDisplayName', () => {
  it('prefers display_name over name and full_name', () => {
    expect(
      resolveDisplayName({
        display_name: 'Alice',
        name: 'Bob',
        full_name: 'Carol',
      }),
    ).toBe('Alice')
  })

  it('falls back to name when display_name is missing (Supabase email signup)', () => {
    // The real test user: signup stored the name under `name`, display_name
    // was unset — the exact bug that made the avatar logic blind to it.
    expect(resolveDisplayName({ name: 'Quick Verify Tester' })).toBe(
      'Quick Verify Tester',
    )
  })

  it('falls back to full_name when only that is present (OAuth)', () => {
    expect(resolveDisplayName({ full_name: 'Jane Doe' })).toBe('Jane Doe')
  })

  it('treats empty and whitespace-only display_name as unset', () => {
    expect(resolveDisplayName({ display_name: '', name: 'Bob' })).toBe('Bob')
    expect(resolveDisplayName({ display_name: '   ', name: 'Bob' })).toBe('Bob')
  })

  it('returns null for empty metadata and nullish input', () => {
    expect(resolveDisplayName({})).toBeNull()
    expect(resolveDisplayName(null)).toBeNull()
    expect(resolveDisplayName(undefined)).toBeNull()
  })
})
