import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://localhost:54321'
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'public-anon-key'

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
  }
})
