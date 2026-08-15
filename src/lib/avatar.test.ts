import { describe, it, expect } from 'vitest'
import { canonicalAvatarState, normalizeEmailSeed } from './avatar'

describe('normalizeEmailSeed', () => {
  it('trims surrounding whitespace and lowercases the email', () => {
    expect(normalizeEmailSeed('  Foo@Bar.COM  ')).toBe('foo@bar.com')
    expect(normalizeEmailSeed('QuICK@Example.org')).toBe('quick@example.org')
  })

  it('returns empty string for empty and whitespace-only input', () => {
    expect(normalizeEmailSeed('')).toBe('')
    expect(normalizeEmailSeed('   ')).toBe('')
  })

  it('returns empty string for null and undefined input', () => {
    expect(normalizeEmailSeed(null)).toBe('')
    expect(normalizeEmailSeed(undefined)).toBe('')
  })
})

describe('canonicalAvatarState', () => {
  it('returns the same-origin endpoint and a normalized email seed when no custom url exists', () => {
    expect(canonicalAvatarState({ email: '  QuickVerify@WWV.local  ' })).toEqual(
      {
        canonicalUrl: '/api/avatar',
        customUrl: null,
        seed: 'quickverify@wwv.local',
      },
    )
  })

  it('keeps customUrl for an https avatar_url while canonicalUrl stays same-origin', () => {
    const state = canonicalAvatarState({
      email: 'alice@example.com',
      user_metadata: { avatar_url: 'https://cdn.example.com/me.png' },
    })
    expect(state.customUrl).toBe('https://cdn.example.com/me.png')
    expect(state.canonicalUrl).toBe('/api/avatar')
  })

  it('accepts http:// custom avatar urls', () => {
    expect(
      canonicalAvatarState({
        user_metadata: { avatar_url: 'http://localhost:3000/me.png' },
      }).customUrl,
    ).toBe('http://localhost:3000/me.png')
  })

  it('keeps customUrl for a data: URL', () => {
    const dataUrl = 'data:image/png;base64,abc123'
    expect(
      canonicalAvatarState({ user_metadata: { avatar_url: dataUrl } })
        .customUrl,
    ).toBe(dataUrl)
  })

  it('rejects non-string custom avatar values', () => {
    expect(
      canonicalAvatarState({ user_metadata: { avatar_url: 42 } }).customUrl,
    ).toBeNull()
    expect(
      canonicalAvatarState({ user_metadata: { avatar_url: null } }).customUrl,
    ).toBeNull()
  })

  it('rejects empty and whitespace-only custom avatar strings', () => {
    expect(
      canonicalAvatarState({ user_metadata: { avatar_url: '' } }).customUrl,
    ).toBeNull()
    expect(
      canonicalAvatarState({ user_metadata: { avatar_url: '   ' } }).customUrl,
    ).toBeNull()
  })

  it('rejects relative-path custom avatars', () => {
    expect(
      canonicalAvatarState({
        user_metadata: { avatar_url: '/uploads/me.png' },
      }).customUrl,
    ).toBeNull()
  })

  it('falls back to the canonical endpoint when only the dicebear marker exists (new signup shape)', () => {
    // Signup now stores only avatar_source: 'dicebear' (never the SVG), so the
    // resolution path must degrade to the same-origin /api/avatar endpoint,
    // which regenerates the face offline from the email seed.
    expect(
      canonicalAvatarState({
        email: 'alice@example.com',
        user_metadata: { avatar_source: 'dicebear' },
      }),
    ).toEqual({
      canonicalUrl: '/api/avatar',
      customUrl: null,
      seed: 'alice@example.com',
    })
  })

  it('keeps the seed stable when display_name or name changes (email stability)', () => {
    // The core requirement: renaming a user must not re-randomize their
    // avatar, because the seed is derived from email, never the display name.
    const original = canonicalAvatarState({
      email: 'Jane@Example.COM',
      user_metadata: { name: 'Jane Doe' },
    })
    const renamed = canonicalAvatarState({
      email: 'Jane@Example.COM',
      user_metadata: { name: 'J. Doe Jr.' },
    })
    const displayRenamed = canonicalAvatarState({
      email: 'Jane@Example.COM',
      user_metadata: { display_name: 'JD' },
    })
    expect(original.seed).toBe('jane@example.com')
    expect(renamed.seed).toBe('jane@example.com')
    expect(displayRenamed.seed).toBe('jane@example.com')
    expect(original.seed).toBe(renamed.seed)
    expect(renamed.seed).toBe(displayRenamed.seed)
  })

  it('handles a null user with empty seed and no custom url', () => {
    expect(canonicalAvatarState(null)).toEqual({
      canonicalUrl: '/api/avatar',
      customUrl: null,
      seed: '',
    })
  })

  it('treats a missing email as an empty seed', () => {
    expect(canonicalAvatarState({}).seed).toBe('')
  })
})
