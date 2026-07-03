import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import RedeemForm from './RedeemForm'

export default async function RedeemPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/redeem')

  const { data: entitlement } = await supabase
    .from('user_entitlements')
    .select('*')
    .eq('user_id', user.id)
    .eq('used_for_instance', false)
    .maybeSingle()

  if (entitlement) redirect('/accounts/instances')

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
