'use server'

import { createHash } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { hasTier } from '@/lib/auth/entitlements'

// Correlation handle for the redemption logs. A code is a single-use credential,
// so the raw value must never reach a log: a truncated digest keeps one attempt
// traceable across log lines without the log holding a usable code.
function codeFingerprint(code: string): string {
  return createHash('sha256').update(code).digest('hex').slice(0, 16)
}

// The generator's shape (src/app/admin/codes/actions.ts): WWV- plus two
// 5-character segments from an alphabet that contains no SQL wildcards.
const CODE_PATTERN = /^WWV-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/

export async function redeemCode(code: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'You must be signed in to redeem a code.' }

  const normalized = code.trim().toUpperCase()
  if (!normalized) return { error: 'Please enter an access code' }

  // Reject anything off-shape before any query runs. `%` and `_` are ILIKE
  // wildcards, so an unvalidated value must never reach a pattern comparison.
  if (!CODE_PATTERN.test(normalized)) {
    console.log('[redeem] malformed code rejected', { userId: user.id, codeFingerprint: codeFingerprint(normalized) })
    return { error: 'Invalid, expired, or already used code' }
  }

  console.log('[redeem] start', { userId: user.id, email: user.email, codeFingerprint: codeFingerprint(normalized) })

  const admin = createAdminClient()

  const { data: accessCode, error: codeError } = await admin
    .from('access_codes')
    .select('*')
    .eq('code', normalized)
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

  // Consume the code BEFORE granting. The other order leaves the loser of a race
  // holding an entitlement row that nothing rolls back, because the conditional
  // update matches no rows only after the insert has already run.
  const { data: consumed } = await admin
    .from('access_codes')
    .update({ use_count: accessCode.use_count + 1 })
    .eq('id', accessCode.id)
    .lt('use_count', accessCode.max_uses)
    .select()

  if (!consumed || consumed.length === 0) {
    console.error('[redeem] use_count update failed (race condition)', { codeId: accessCode.id })
    return { error: 'Code was just redeemed by someone else. Please try again.' }
  }

  const consumedCount = consumed[0]?.use_count ?? accessCode.use_count + 1

  console.log('[redeem] use_count updated', { codeId: accessCode.id, newCount: consumedCount })

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
    // Compensate rather than burn the use: hand it back, guarded on the value we
    // wrote so a concurrent redemption is never clobbered.
    const { data: rolledBack, error: rollbackError } = await admin
      .from('access_codes')
      .update({ use_count: Math.max(0, consumedCount - 1) })
      .eq('id', accessCode.id)
      .eq('use_count', consumedCount)
      .select()

    if (rollbackError || !rolledBack || rolledBack.length === 0) {
      console.error('[redeem] CRITICAL: entitlement insert failed and the consumed use could not be returned', { codeId: accessCode.id, error: insertError.message, code: insertError.code, rollbackError: rollbackError?.message })
    } else {
      console.error('[redeem] entitlement insert failed, consumed use returned', { codeId: accessCode.id, error: insertError.message, code: insertError.code })
    }

    return { error: 'Failed to redeem code. Please try again.' }
  }

  console.log('[redeem] entitlement inserted', { userId: user.id, codeId: accessCode.id, tier: accessCode.tier })

  console.log('[redeem] success', { userId: user.id, tier: accessCode.tier })

  return { success: true, tier: accessCode.tier }
}
