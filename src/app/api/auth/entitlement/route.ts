import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getUserEntitlement } from '@/lib/auth/entitlements'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const entitlement = await getUserEntitlement(user.id)

  return NextResponse.json({
    hasEntitlement: entitlement !== null,
    entitlementUsed: entitlement === null
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
