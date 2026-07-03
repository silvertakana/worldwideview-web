import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function getUserEntitlement(userId: string) {
  const supabase = await createClient()
  const { data } = await supabase
    .from('user_entitlements')
    .select('*')
    .eq('user_id', userId)
    .eq('used_for_instance', false)
    .maybeSingle()
  return data
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
