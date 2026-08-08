import { redirect } from 'next/navigation'
import { createClient } from '../../lib/supabase/server'
import { resolveDisplayName } from '../../lib/avatarFallback'
import { canonicalAvatarState } from '../../lib/avatar'
import { AccountPageClient } from './AccountPageClient'

export const metadata = { title: 'Your Account' }

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?next=/accounts')
  }

  const params = await searchParams
  const justLinked = params.linked === '1'
  const email = user.email ?? 'your account'
  // Signup stores the name under `name` (Supabase email signup) while the app
  // historically read only `display_name`; resolve both (plus OAuth full_name).
  const displayName = resolveDisplayName(user.user_metadata)
  // Shared resolver: the browser renders the same-origin /api/avatar endpoint
  // (the route 307s to a custom avatar_url or proxies DiceBear server-side),
  // so the nav and accounts avatars can never diverge.
  const avatarState = canonicalAvatarState(user)

  return (
    <AccountPageClient
      email={email}
      initialDisplayName={displayName}
      avatarSrc={avatarState.canonicalUrl}
      initialAvatarUrl={avatarState.customUrl}
      justLinked={justLinked}
    />
  )
}
