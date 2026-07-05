import { createAdminClient } from '@/lib/supabase/admin'

export interface Entitlement {
  id: string
  user_id: string
  tier: string
  revoked_at: string | null
  used_for_instance: boolean
  grants_days: number
}

export async function getUserEntitlements(userId: string): Promise<Entitlement[]> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('user_entitlements')
    .select('id, user_id, tier, revoked_at, used_for_instance, grants_days')
    .eq('user_id', userId)
    .is('revoked_at', null)
  return data ?? []
}

export async function hasTier(userId: string, tier: string): Promise<boolean> {
  const entitlements = await getUserEntitlements(userId)
  return entitlements.some(e => e.tier === tier)
}

export async function hasInstanceEntitlement(userId: string): Promise<boolean> {
  const entitlements = await getUserEntitlements(userId)
  return entitlements.length > 0
}

const TIER_RANK: Record<string, number> = {
  free: 0, beta_tester: 1, early_access: 2, pro: 3, enterprise: 4
}

export async function getHighestTier(userId: string): Promise<string> {
  const entitlements = await getUserEntitlements(userId)
  if (entitlements.length === 0) return 'free'
  return entitlements.reduce((highest, e) =>
    (TIER_RANK[e.tier] ?? 0) > (TIER_RANK[highest] ?? 0) ? e.tier : highest
  , 'free')
}

export async function markEntitlementUsed(userId: string): Promise<void> {
  const admin = createAdminClient()
  await admin
    .from('user_entitlements')
    .update({ used_for_instance: true, instance_created_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('used_for_instance', false)
    .is('revoked_at', null)
    .limit(1)
}
