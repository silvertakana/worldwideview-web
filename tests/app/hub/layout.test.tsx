import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import HubLayout from '../../../src/app/hub/layout'

const { mockRedirect, mockGetClaims } = vi.hoisted(() => ({
  mockRedirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`) }),
  mockGetClaims: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
}))

vi.mock('../../../src/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getClaims: mockGetClaims },
  }),
}))

describe('Hub Layout (server component)', () => {
  it('renders children when the user is authenticated', async () => {
    mockGetClaims.mockResolvedValue({
      data: { claims: { sub: 'user-1', email: 'a@b.test' } },
    })
    const ui = await HubLayout({ children: <div>Hub Content</div> })
    render(ui as React.ReactElement)
    expect(screen.getByText('Hub Content')).toBeInTheDocument()
  })

  it('redirects to /login?next=/hub when there is no session', async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: null } })
    await expect(
      HubLayout({ children: <div>Hub Content</div> }),
    ).rejects.toThrow('REDIRECT:/login?next=/hub')
  })
})
