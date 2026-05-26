import { redirect } from 'next/navigation'
import { createClient } from '../../lib/supabase/server'
import { AccountPageClient } from './AccountPageClient'

export const metadata = { title: 'Your Account' }

export default async function AccountsPage() {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()
  const claims = data?.claims

  if (!claims) {
    redirect('/login?next=/accounts')
  }

  const email = typeof claims.email === 'string' ? claims.email : 'your account'
  const displayName =
    typeof claims.user_metadata?.display_name === 'string'
      ? claims.user_metadata.display_name
      : null

  return <AccountPageClient email={email} initialDisplayName={displayName} />
}
