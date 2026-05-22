import { describe, it, expect } from 'vitest'
import { createClient } from '../../../src/lib/supabase/client'

describe('Supabase Client', () => {
  it('exports a createClient factory', () => {
    expect(typeof createClient).toBe('function')
  })
})
