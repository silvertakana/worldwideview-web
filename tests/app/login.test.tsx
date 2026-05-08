import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import LoginPage from '../../src/app/login/page'

describe('Login Page', () => {
  it('renders login heading', () => {
    render(<LoginPage />)
    expect(screen.getByRole('heading', { name: /login/i })).toBeInTheDocument()
  })
})
