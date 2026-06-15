import React from 'react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

describe('Billing Page', () => {
  it('redirects to /accounts/billing', async () => {
    const { default: HubBillingPage } = await import('../../../../src/app/hub/billing/page')
    HubBillingPage()
    const { redirect } = await import('next/navigation')
    expect(redirect).toHaveBeenCalledWith('/accounts/billing')
  })
})
