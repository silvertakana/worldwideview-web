import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import type { User } from '@supabase/supabase-js'

// ── Hoisted mocks ─────────────────────────────────────────────────
const mockTrackEvent = vi.hoisted(() => vi.fn())

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('@/lib/analytics', () => ({
  trackEvent: mockTrackEvent,
}))

vi.mock('@/lib/billing/constants', () => ({
  BILLING_ENABLED: false,
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
    },
  }),
}))

import Header from './Header'

// The real test user from the 2026-08-08 investigation: signup stored the
// name under `name`, display_name was unset, and commit 14a5342 passed the
// bare user id as the initials seed -> "4B" in the header.
const TEST_USER_ID = '41332691-b37e-4bea-b82d-daf0e4fba48d'

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: TEST_USER_ID,
    email: 'quickverify@worldwideview.local',
    user_metadata: {},
    app_metadata: {},
    aud: 'authenticated',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as User
}

function initialsFromDataUrl(src: string): string {
  const svg = decodeURIComponent(src.replace('data:image/svg+xml;utf8,', ''))
  const match = svg.match(/>([^<]+?)<\/text>/)
  return match ? match[1] : ''
}

describe('Header avatar', () => {
  beforeEach(() => {
    mockTrackEvent.mockReset()
  })

  it('always renders the canonical /api/avatar endpoint (custom avatar redirect handled server-side)', () => {
    const user = makeUser({
      user_metadata: { avatar_url: 'https://storage.example.com/avatars/a.jpg' },
    })
    const { container } = render(<Header initialUser={user} />)
    const img = container.querySelector('img[alt=""]') as HTMLImageElement
    expect(img).toBeTruthy()
    // The endpoint 307s to the custom URL; the component never embeds it.
    expect(img.getAttribute('src')).toBe('/api/avatar')
  })

  it('renders src=/api/avatar for a plain user and never a direct dicebear URL (never-diverge lock)', () => {
    const user = makeUser()
    const { container } = render(<Header initialUser={user} />)
    const img = container.querySelector('img[alt=""]') as HTMLImageElement
    expect(img).toBeTruthy()
    expect(img.getAttribute('src')).toBe('/api/avatar')
    expect(container.innerHTML).not.toContain('dicebear')
  })

  it('falls back to initials from the resolved display name on error, not user.id', async () => {
    // display_name is set: the fallback must be "QV", never "4B" (user.id).
    const user = makeUser({
      user_metadata: { display_name: 'Quick Verify Tester' },
    })
    const { container } = render(<Header initialUser={user} />)
    await waitFor(() => {
      expect(container.querySelector('img[alt=""]')).not.toBeNull()
    })
    const img = container.querySelector('img[alt=""]') as HTMLImageElement

    fireEvent.error(img)

    await waitFor(() => {
      const fallback = container.querySelector('img[alt=""]') as HTMLImageElement
      expect(fallback.src.startsWith('data:image/svg+xml')).toBe(true)
      expect(initialsFromDataUrl(fallback.src)).toBe('QV')
    })
  })

  it('uses the name key when display_name is missing (Supabase email signup)', async () => {
    // The exact real-world data shape: name only, no display_name.
    const user = makeUser({ user_metadata: { name: 'Quick Verify Tester' } })
    const { container } = render(<Header initialUser={user} />)
    await waitFor(() => {
      expect(container.querySelector('img[alt=""]')).not.toBeNull()
    })
    const img = container.querySelector('img[alt=""]') as HTMLImageElement

    fireEvent.error(img)

    await waitFor(() => {
      const fallback = container.querySelector('img[alt=""]') as HTMLImageElement
      expect(initialsFromDataUrl(fallback.src)).toBe('QV')
    })
  })

  it('falls back to email-based initials when no name exists (never user.id)', async () => {
    // No name anywhere: the fallback seeds from the normalized email
    // ("quickverify@worldwideview.local" -> "QW"), never from user.id ("4B").
    const user = makeUser({ user_metadata: {} })
    const { container } = render(<Header initialUser={user} />)
    await waitFor(() => {
      expect(container.querySelector('img[alt=""]')).not.toBeNull()
    })
    const img = container.querySelector('img[alt=""]') as HTMLImageElement

    fireEvent.error(img)

    await waitFor(() => {
      const fallback = container.querySelector('img[alt=""]') as HTMLImageElement
      expect(initialsFromDataUrl(fallback.src)).toBe('QW')
    })
  })
})
