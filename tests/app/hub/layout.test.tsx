import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import HubLayout from '../../../src/app/hub/layout'

// Mock useRouter
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() })
}))

// Mock Supabase
vi.mock('../../../src/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: {} } } })
    }
  }
}))

describe('Hub Layout', () => {
  it('renders children', async () => {
    render(<HubLayout><div>Hub Content</div></HubLayout>)
    expect(await screen.findByText('Hub Content')).toBeInTheDocument()
  })
})
