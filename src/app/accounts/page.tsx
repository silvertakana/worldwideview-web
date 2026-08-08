import { redirect } from 'next/navigation'
import { createClient } from '../../lib/supabase/server'
import { resolveDisplayName } from '../../lib/avatarFallback'
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
  const avatarUrl =
    typeof user.user_metadata?.avatar_url === 'string'
      ? user.user_metadata.avatar_url
      : null

  return (
    <AccountPageClient
      email={email}
      initialDisplayName={displayName}
      initialAvatarUrl={avatarUrl}
      justLinked={justLinked}
    />
  )
}
