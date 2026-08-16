import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

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
  it('renders the persisted avatar URL when one exists (canonical endpoint bypassed)', () => {
    render(
      <AvatarUpload
        name="Quick Verify Tester"
        initialAvatarUrl="https://storage.example.com/avatars/x.jpg"
      />,
    )
    const img = screen.getByAltText('Your avatar') as HTMLImageElement
    expect(img.src).toBe('https://storage.example.com/avatars/x.jpg')
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

  it('renders the canonical /api/avatar endpoint when nothing is persisted (never-diverge lock)', () => {
    const { container } = render(
      <AvatarUpload name="Quick Verify Tester" initialAvatarUrl={null} />,
    )
    const img = screen.getByAltText('Your avatar') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/api/avatar')
    expect(container.innerHTML).not.toContain('dicebear')
  })

  it('falls back to email-derived initials when the avatar image fails and no name exists', async () => {
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
