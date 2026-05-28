import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import BillingPage from '../../../../src/app/hub/billing/page'

// Mock Supabase
vi.mock('../../../../src/lib/supabase/client', () => ({
  createClient: () => ({
    functions: {
      invoke: vi.fn().mockResolvedValue({ data: { url: 'http://stripe.test' } })
    }
  })
}))

describe('Billing Page', () => {
  it('renders billing heading', () => {
    render(<BillingPage />)
    expect(screen.getByRole('heading', { name: /billing/i })).toBeInTheDocument()
  })
})
