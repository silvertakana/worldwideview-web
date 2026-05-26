// Service-role Supabase client. NEVER import from client components
// or pages marked 'use client'. Requires SUPABASE_SERVICE_ROLE_KEY (no NEXT_PUBLIC_ prefix).
import 'server-only'
import { createClient } from '@supabase/supabase-js'

export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    },
  )
}
