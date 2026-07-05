import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import RedeemForm from './RedeemForm'

export default async function RedeemPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  // nosemgrep: semgrep.unsanitized-redirect - hardcoded path, not user-controlled
  if (!user) redirect('/login?next=/redeem')


  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 'var(--space-md)',
      background: 'radial-gradient(circle at top center, var(--color-bg-card-hover), var(--color-bg))',
    }}>
      <RedeemForm />
    </div>
  )
}
