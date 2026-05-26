// Service-role Supabase client. NEVER import from client components
// or pages marked 'use client'. Requires SUPABASE_SERVICE_ROLE_KEY (no NEXT_PUBLIC_ prefix).
import 'server-only'
import { createClient } from '@supabase/supabase-js'

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set. Check worldwideview-web/.env.local.')
  }
  if (!serviceRoleKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not set. Required for admin operations (account deletion). ' +
        'Add it to worldwideview-web/.env.local. Source: Supabase Dashboard > API Keys > Secret key.',
    )
  }
  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  })
}
