// Service-role Supabase client. NEVER import from client components
// or pages marked 'use client'. Requires SUPABASE_SERVICE_ROLE_KEY (no NEXT_PUBLIC_ prefix).
import 'server-only'
import { createClient } from '@supabase/supabase-js'

export function createAdminClient() {
  // Server-to-server: prefer SUPABASE_INTERNAL_URL (e.g. host.docker.internal
  // inside Docker) over the browser-facing NEXT_PUBLIC_SUPABASE_URL (loopback,
  // inlined into client bundles). Local dev leaves SUPABASE_INTERNAL_URL unset.
  const url =
    process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url) {
    throw new Error(
      'Supabase URL is not set. Set SUPABASE_INTERNAL_URL or NEXT_PUBLIC_SUPABASE_URL. Check worldwideview-web/.env.local.',
    )
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
