import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockReplace = vi.fn()

vi.mock('next/navigation', () => ({
  useSearchParams: vi.fn(),
  useRouter: vi.fn(() => ({ replace: mockReplace })),
}))

vi.mock('../../../../src/app/auth/verify/actions', () => ({
  verifyEmail: vi.fn(),
}))

import { useSearchParams, useRouter } from 'next/navigation'
import { verifyEmail } from '../../../../src/app/auth/verify/actions'
import VerifyPage from '../../../../src/app/auth/verify/page'

describe('Auth Verify Page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(useRouter as any).mockReturnValue({ replace: mockReplace })
  })

  it('redirects to /accounts when no ?next= is provided', async () => {
    ;(useSearchParams as any).mockReturnValue({
      get: (key: string) => (key === 'code' ? 'valid-code' : null),
    })
    ;(verifyEmail as any).mockResolvedValueOnce({ success: true })

    render(await VerifyPage())
    await screen.findByText('Verifying...')

    // Wait for effect to run
    await vi.waitFor(() => {
      expect(verifyEmail).toHaveBeenCalledWith('valid-code')
      expect(mockReplace).toHaveBeenCalledWith('/accounts')
    })
  })

  it('redirects to ?next= URL when provided', async () => {
    ;(useSearchParams as any).mockReturnValue({
      get: (key: string) => {
        if (key === 'code') return 'valid-code'
        if (key === 'next') return '/browse/some-plugin'
        return null
      },
    })
    ;(verifyEmail as any).mockResolvedValueOnce({ success: true })

    render(await VerifyPage())
    await screen.findByText('Verifying...')

    await vi.waitFor(() => {
      expect(verifyEmail).toHaveBeenCalledWith('valid-code')
      expect(mockReplace).toHaveBeenCalledWith('/browse/some-plugin')
    })
  })

  it('rejects external ?next= URL and falls back to /accounts', async () => {
    ;(useSearchParams as any).mockReturnValue({
      get: (key: string) => {
        if (key === 'code') return 'valid-code'
        if (key === 'next') return 'http://evil.com'
        return null
      },
    })
    ;(verifyEmail as any).mockResolvedValueOnce({ success: true })

    render(await VerifyPage())
    await screen.findByText('Verifying...')

    await vi.waitFor(() => {
      expect(verifyEmail).toHaveBeenCalledWith('valid-code')
      expect(mockReplace).toHaveBeenCalledWith('/accounts')
    })
  })

  it('rejects protocol-relative ?next= URL and falls back to /accounts', async () => {
    ;(useSearchParams as any).mockReturnValue({
      get: (key: string) => {
        if (key === 'code') return 'valid-code'
        if (key === 'next') return '//evil.com/hack'
        return null
      },
    })
    ;(verifyEmail as any).mockResolvedValueOnce({ success: true })

    render(await VerifyPage())
    await screen.findByText('Verifying...')

    await vi.waitFor(() => {
      expect(verifyEmail).toHaveBeenCalledWith('valid-code')
      expect(mockReplace).toHaveBeenCalledWith('/accounts')
    })
  })

  it('shows error state when no code is provided', async () => {
    ;(useSearchParams as any).mockReturnValue({
      get: () => null,
    })

    render(await VerifyPage())

    expect(
      await screen.findByText(/This verification link has expired/i),
    ).toBeInTheDocument()
  })

  it('shows error state when verification fails', async () => {
    ;(useSearchParams as any).mockReturnValue({
      get: (key: string) => (key === 'code' ? 'bad-code' : null),
    })
    ;(verifyEmail as any).mockResolvedValueOnce({ success: false })

    render(await VerifyPage())

    await vi.waitFor(() => {
      expect(
        screen.getByText(/This verification link has expired/i),
      ).toBeInTheDocument()
    })
  })
})
