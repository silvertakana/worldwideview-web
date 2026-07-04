import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function getUserEntitlement(userId: string) {
  const supabase = await createClient()
  const { data: entitlement } = await supabase
    .from('user_entitlements')
    .select('*')
    .eq('user_id', userId)
    .eq('used_for_instance', false)
    .maybeSingle()

  if (entitlement?.code_id) {
    const admin = createAdminClient()
    const { data: code } = await admin
      .from('access_codes')
      .select('revoked_at')
      .eq('id', entitlement.code_id)
      .single()
    if (code?.revoked_at) return null
  }

  return entitlement
}

export async function hasInstanceEntitlement(userId: string) {
  const entitlement = await getUserEntitlement(userId)
  return entitlement !== null
}

export async function markEntitlementUsed(userId: string) {
  const admin = createAdminClient()
  await admin
    .from('user_entitlements')
    .update({ used_for_instance: true, instance_created_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('used_for_instance', false)
}
