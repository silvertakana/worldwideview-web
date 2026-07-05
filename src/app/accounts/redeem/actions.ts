'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { hasTier } from '@/lib/auth/entitlements'
import { crossServiceFetch } from '@/lib/cross-service/fetch'

export async function redeemCode(code: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'You must be signed in to redeem a code.' }

  const trimmed = code.trim()
  if (!trimmed) return { error: 'Please enter an access code' }

  console.log('[redeem] start', { userId: user.id, email: user.email, code: trimmed })

  const admin = createAdminClient()

  const { data: accessCode, error: codeError } = await admin
    .from('access_codes')
    .select('*')
    .ilike('code', trimmed)
    .is('revoked_at', null)
    .single()

  if (codeError || !accessCode) {
    console.log('[redeem] code lookup failed', { codeError: codeError?.message })
    return { error: 'Invalid, expired, or already used code' }
  }

  console.log('[redeem] code lookup', { found: true, codeId: accessCode.id, tier: accessCode.tier, revoked: !!accessCode.revoked_at, expired: accessCode.expires_at && new Date(accessCode.expires_at) <= new Date(), useCount: accessCode.use_count, maxUses: accessCode.max_uses })

  if (accessCode.expires_at && new Date(accessCode.expires_at) <= new Date()) {
    console.log('[redeem] code expired', { codeId: accessCode.id, expiresAt: accessCode.expires_at })
    return { error: 'Invalid, expired, or already used code' }
  }

  if (accessCode.use_count >= accessCode.max_uses) {
    console.log('[redeem] code exhausted', { codeId: accessCode.id, useCount: accessCode.use_count, maxUses: accessCode.max_uses })
    return { error: 'Invalid, expired, or already used code' }
  }

  if (await hasTier(user.id, accessCode.tier)) {
    console.log('[redeem] entitlement exists', { userId: user.id, tier: accessCode.tier })
    return { error: `You already have ${accessCode.tier} access` }
  }

  console.log('[redeem] entitlement check passed', { userId: user.id, tier: accessCode.tier })

  const { error: insertError } = await admin
    .from('user_entitlements')
    .insert({
      user_id: user.id,
      code_id: accessCode.id,
      source: 'access_code',
      grants_days: accessCode.grants_days,
      tier: accessCode.tier,
    })

  if (insertError) {
    console.error('[redeem] entitlement insert failed', { error: insertError.message, code: insertError.code })
    return { error: 'Failed to redeem code. Please try again.' }
  }

  console.log('[redeem] entitlement inserted', { userId: user.id, codeId: accessCode.id, tier: accessCode.tier })

  const { data: updated } = await admin
    .from('access_codes')
    .update({ use_count: accessCode.use_count + 1 })
    .eq('id', accessCode.id)
    .lt('use_count', accessCode.max_uses)
    .select()

  if (!updated || updated.length === 0) {
    console.error('[redeem] use_count update failed (race condition)', { codeId: accessCode.id })
    return { error: 'Code was just redeemed by someone else. Please try again.' }
  }

  console.log('[redeem] use_count updated', { codeId: accessCode.id, newCount: accessCode.use_count + 1 })

  console.log('[redeem] calling globe', { url: '/api/access-code', userId: user.id, email: user.email })

  try {
    const res = await crossServiceFetch('/api/access-code', {
      method: 'POST',
      body: { code: accessCode.code, userId: user.id, email: user.email },
    })
    const body = await res.text()
    console.log('[redeem] globe response', { status: res.status, ok: res.ok, body })

    if (!res.ok) {
      console.error('[redeem] globe request failed', { status: res.status, body })
      if (res.status === 404) {
        return { error: 'Account provisioning failed. Please contact support.' }
      }
      if (res.status >= 500) {
        return { error: 'Service temporarily unavailable. Please try again.' }
      }
      return { error: 'Failed to activate access on the globe. Please contact support.' }
    }
  } catch (err) {
    console.error('[redeem] globe network error', { error: err instanceof Error ? err.message : String(err) })
    return { error: 'Cannot reach the globe service. Please try again.' }
  }

  console.log('[redeem] success', { userId: user.id, tier: accessCode.tier })

  return { success: true, tier: accessCode.tier }
}
