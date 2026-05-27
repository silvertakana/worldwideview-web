import { redirect } from 'next/navigation'
import { createClient } from '../../lib/supabase/server'
import { AccountPageClient } from './AccountPageClient'

export const metadata = { title: 'Your Account' }

export default async function AccountsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?next=/accounts')
  }

  const email = user.email ?? 'your account'
  const displayName =
    typeof user.user_metadata?.display_name === 'string'
      ? user.user_metadata.display_name
      : null
  const avatarUrl =
    typeof user.user_metadata?.avatar_url === 'string'
      ? user.user_metadata.avatar_url
      : null

  return (
    <AccountPageClient
      email={email}
      initialDisplayName={displayName}
      initialAvatarUrl={avatarUrl}
    />
  )
}
