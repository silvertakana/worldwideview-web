'use server'

import { createClient } from '../../lib/supabase/server'

export type SignInWithOAuthResult =
  | { ok: true; url: string }
  | { ok: false; error: string }

/**
 * Starts the PKCE OAuth flow on the server and returns the provider URL.
 *
 * IMPORTANT: do NOT call `redirect(data.url)` from inside this action. The
 * Supabase SSR client writes the PKCE `code-verifier` cookie via the
 * `cookieStore.set` callback as a `Set-Cookie` on the action's HTTP response.
 * When the action is invoked from an `onClick` handler (not a `<form action>`),
 * a server-side `redirect()` to an absolute external URL races against the
 * browser committing those `Set-Cookie` headers — the browser can navigate to
 * the provider before the verifier is in the cookie jar. The OAuth provider
 * later bounces to `<supabase>/auth/v1/callback`, which finds no verifier and
 * redirects to Site URL with `?error_code=bad_oauth_state`.
 *
 * Returning the URL to the client and letting it perform
 * `window.location.assign(url)` guarantees the action response (with
 * `Set-Cookie`) is fully applied before the provider navigation starts.
 */
export async function signInWithOAuth(
  provider: 'google' | 'github',
  next: string,
): Promise<SignInWithOAuthResult> {
  const supabase = await createClient()
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL!
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: `${siteUrl}/api/auth/callback?next=${encodeURIComponent(next)}`,
    },
  })

  if (error || !data?.url) {
    return { ok: false, error: 'OAuth sign-in failed. Please try again.' }
  }

  return { ok: true, url: data.url }
}
