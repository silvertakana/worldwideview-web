import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import LoginPage from '../../src/app/login/page'

describe('Login Page', () => {
  it('renders the sign-in heading', async () => {
    const ui = await LoginPage({ searchParams: Promise.resolve({}) })
    render(ui)
    expect(
      screen.getByRole('heading', { name: /welcome back/i }),
    ).toBeInTheDocument()
  })
})
