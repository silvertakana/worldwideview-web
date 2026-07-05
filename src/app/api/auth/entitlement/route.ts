import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getUserEntitlements } from '@/lib/auth/entitlements'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const entitlements = await getUserEntitlements(user.id)

  return NextResponse.json({
    hasEntitlement: entitlements.length > 0,
    entitlementUsed: entitlements.length === 0
      ? await supabase
          .from('user_entitlements')
          .select('id')
          .eq('user_id', user.id)
          .eq('used_for_instance', true)
          .maybeSingle()
          .then(r => r.data !== null)
      : false,
  })
}
