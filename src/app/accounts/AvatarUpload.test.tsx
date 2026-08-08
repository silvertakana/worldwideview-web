import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// ── Hoisted mocks ─────────────────────────────────────────────────
const mockUseDiceBearUrl = vi.hoisted(() => vi.fn())

vi.mock('@/lib/useDiceBearUrl', () => ({
  useDiceBearUrl: mockUseDiceBearUrl,
}))

vi.mock('./actions', () => ({
  updateAvatar: vi.fn(),
}))

import { AvatarUpload } from './AvatarUpload'

function initialsFromDataUrl(src: string): string {
  const svg = decodeURIComponent(src.replace('data:image/svg+xml;utf8,', ''))
  const match = svg.match(/>([^<]+?)<\/text>/)
  return match ? match[1] : ''
}

describe('AvatarUpload', () => {
  beforeEach(() => {
    mockUseDiceBearUrl.mockImplementation((seed: string | null) =>
      seed
        ? `https://api.dicebear.com/9.x/adventurer-neutral/svg?seed=hashed-${seed}`
        : null,
    )
  })

  it('renders the persisted avatar URL when one exists (dicebear bypassed)', () => {
    render(
      <AvatarUpload
        name="Quick Verify Tester"
        initialAvatarUrl="https://storage.example.com/avatars/x.jpg"
      />,
    )
    const img = screen.getByAltText('Your avatar') as HTMLImageElement
    expect(img.src).toBe('https://storage.example.com/avatars/x.jpg')
    expect(mockUseDiceBearUrl).toHaveBeenCalledWith(null)
  })

  it('falls back to initials from the display name when the image fails', async () => {
    render(
      <AvatarUpload
        name="Quick Verify Tester"
        initialAvatarUrl="https://storage.example.com/avatars/x.jpg"
      />,
    )
    const img = screen.getByAltText('Your avatar')
    fireEvent.error(img)

    await waitFor(() => {
      const fallback = screen.getByAltText('Your avatar') as HTMLImageElement
      expect(fallback.src.startsWith('data:image/svg+xml')).toBe(true)
      expect(initialsFromDataUrl(fallback.src)).toBe('QV')
    })
  })

  it('seeds dicebear with the display name when nothing is persisted', () => {
    render(<AvatarUpload name="Quick Verify Tester" initialAvatarUrl={null} />)
    const img = screen.getByAltText('Your avatar') as HTMLImageElement
    expect(mockUseDiceBearUrl).toHaveBeenCalledWith('Quick Verify Tester')
    expect(img.src).toContain('api.dicebear.com')
  })

  it('falls back to email-derived initials when the dicebear image fails and no name exists', async () => {
    render(
      <AvatarUpload
        name="quickverify@worldwideview.local"
        initialAvatarUrl={null}
      />,
    )
    const img = screen.getByAltText('Your avatar')
    fireEvent.error(img)

    await waitFor(() => {
      const fallback = screen.getByAltText('Your avatar') as HTMLImageElement
      expect(initialsFromDataUrl(fallback.src)).toBe('QW')
    })
  })
})
