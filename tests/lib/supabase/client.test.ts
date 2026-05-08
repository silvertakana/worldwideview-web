import { describe, it, expect } from 'vitest'
import { supabase } from '../../../src/lib/supabase/client'

describe('Supabase Client', () => {
  it('should be initialized', () => {
    expect(supabase).toBeDefined()
  })
})
