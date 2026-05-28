import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import HubDashboard from '../../../src/app/hub/page'

// Mock Supabase
vi.mock('../../../src/lib/supabase/client', () => ({
  createClient: () => ({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockResolvedValue({ data: [] })
    })
  })
}))

describe('Hub Dashboard', () => {
  it('renders dashboard heading', async () => {
    render(<HubDashboard />)
    expect(await screen.findByRole('heading', { name: /workspaces/i })).toBeInTheDocument()
  })
})
