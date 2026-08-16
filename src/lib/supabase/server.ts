import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { buildCookieOptions } from './cookieOptions'

/**
 * Supabase client for Server Components, Server Actions, and Route Handlers.
 * A fresh client is created per request — never share it across requests.
 *
 * URL resolution: SUPABASE_INTERNAL_URL (server-to-server, e.g. inside Docker
 * host.docker.internal) takes precedence over NEXT_PUBLIC_SUPABASE_URL (the
 * browser-facing, loopback URL inlined into client bundles). Local dev leaves
 * SUPABASE_INTERNAL_URL unset, so the public URL is used.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookieOptions: buildCookieOptions(),
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // setAll throws when called from a Server Component render —
            // the middleware refreshes and writes the session cookie instead.
          }
        },
      },
    },
  )
}
