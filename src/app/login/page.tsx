import LoginForm from './login-form'
import { safeNext } from '../../lib/safeNext'

export const metadata = { title: 'Sign In' }

/**
 * Server component wrapper.
 *
 * Reads search params and delegates to the client-side LoginForm, which
 * performs `signInWithPassword` via the browser Supabase client so session
 * cookies are committed to `document.cookie` before navigation.
 *
 * This eliminates the race between `redirect()` and cookie flush that left
 * the navbar stale after sign-in.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string; next?: string }>
}) {
  const params = await searchParams
  const next = safeNext(params.next)

  return <LoginForm next={next} error={params.error} message={params.message} />
}
