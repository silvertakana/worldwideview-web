'use server'

import { createHash } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { hasTier } from '@/lib/auth/entitlements'
import { GLOBE_TIERS, isGlobeTier } from '@/lib/billing/globe-tiers'
import { pushTierToGlobe } from '@/lib/billing/globe-sync'
import { recordFailure } from '@/lib/billing/records'
import { resolveEffectiveHubTier, tierRank } from '@/lib/billing/tier-rank'
import { notify } from '@/lib/alerts/notify'

// Correlation handle for the redemption logs. A code is a single-use credential,
// so the raw value must never reach a log: a truncated digest keeps one attempt
// traceable across log lines without the log holding a usable code.
function codeFingerprint(code: string): string {
  return createHash('sha256').update(code).digest('hex').slice(0, 16)
}

// The generator's shape (src/app/admin/codes/actions.ts): WWV- plus two
// 5-character segments from an alphabet that contains no SQL wildcards.
const CODE_PATTERN = /^WWV-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/

/**
 * Shown to the customer when the entitlement landed and the globe was not told.
 * It says the code is spent, because it is: re-entering it returns "already used"
 * and would read as though their redemption was rejected.
 */
const GLOBE_FAILURE_MESSAGE =
  'Your code was accepted, but we could not switch on your cloud access yet. Support has been alerted and will finish this for you, so please do not enter the code again.'

export type RedeemResult =
  | { success: true; tier: string }
  | {
      /**
       * The partial failure, shaped like grantManualOverride's `{ ok: false, stage:
       * "globe" }` (src/lib/billing/manual-override.ts): `granted` marks that the
       * first of the two writes landed, so a caller can tell "you have access we
       * have not switched on" apart from "nothing happened". The message is
       * written to be shown to the customer verbatim.
       */
      error: string
      granted?: boolean
      stage?: 'globe'
    }

/**
 * One open failure row per customer, so a repeated attempt counts up (attempts on
 * billing_failures) instead of filling the operator queue with duplicates. The
 * webhook keys its rows by Stripe event id and manual overrides use their own
 * prefix, so the three never collide.
 */
function redeemFailureKey(userId: string): string {
  return `redeem:${userId}`
}

async function reportGlobeGrantFailure(input: {
  userId: string
  email: string | null
  codeId: string
  tier: string
  detail: string
}): Promise<void> {
  await recordFailure({
    userId: input.userId,
    email: input.email,
    eventId: redeemFailureKey(input.userId),
    eventType: 'redeem_code',
    stage: 'tier_sync',
    error: input.detail,
  })

  // Identifiers only, and deliberately NO customer email: notify() strips every
  // email it is given, by design and by test (src/lib/alerts/notify.ts). The hub
  // user id is the handle the operator acts on - pasted into /admin/overrides it
  // resolves the customer, their entitlements and the globe's own view.
  await notify(
    'critical',
    'Access code redeemed but the globe was never told',
    `${input.detail} The code is consumed and the entitlement is recorded, so the customer holds access the globe is not granting: they cannot create an instance until this push succeeds.`,
    {
      userId: input.userId,
      codeId: input.codeId,
      tier: input.tier,
      eventId: redeemFailureKey(input.userId),
    },
  )
}

export async function redeemCode(code: string): Promise<RedeemResult> {
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

  // ── the second write, which did not exist ───────────────────────────────────
  //
  // Access lives on the globe: the entitlement row above is the hub's record of
  // the decision, and until this call the globe was never told about it. A
  // redeemed code therefore produced a row and no access - the same two-write
  // failure grantManualOverride exists to catch, on the one path that never got
  // the second write. Same order, same partial-failure report.
  const email = user.email ?? ''

  // WHICH TIER, and why it is not simply accessCode.tier. Redeeming a code must
  // never REDUCE what a customer already has, so a Team subscriber redeeming a
  // Pro code must not have the globe downgraded to Pro by the act of redeeming.
  // The tier pushed is therefore the customer's effective tier across every
  // source (Stripe, entitlements, operator override), floored at the tier this
  // code just granted - a resolution that comes back "free" because a read failed
  // must not revoke anything either.
  const resolution = await resolveEffectiveHubTier(user.id, email)
  const tier = tierRank(resolution.tier) >= tierRank(accessCode.tier) ? resolution.tier : accessCode.tier

  if (!email) {
    const detail = 'the account has no email address, and the globe files a tier under the customer email'
    console.error('[redeem] cannot push to the globe', { userId: user.id, codeId: accessCode.id, reason: detail })
    await reportGlobeGrantFailure({ userId: user.id, email: null, codeId: accessCode.id, tier, detail })
    return { error: GLOBE_FAILURE_MESSAGE, granted: true, stage: 'globe' }
  }

  if (!isGlobeTier(tier)) {
    // The customer's only tier is one the globe cannot express: a code issued
    // before generation was restricted to globe tiers (src/lib/billing/code-tiers.ts),
    // with nothing above it to lift them into range. The hub has granted it and the
    // globe cannot mirror it, so this is the same partial failure as a rejected
    // push, and is recorded and alerted rather than left as a silent no-op.
    const detail = `the resolved tier "${tier}" is not one the globe's tier-sync accepts (${GLOBE_TIERS.join(', ')})`
    console.error('[redeem] cannot push to the globe', { userId: user.id, codeId: accessCode.id, tier })
    await reportGlobeGrantFailure({ userId: user.id, email, codeId: accessCode.id, tier, detail })
    return { error: GLOBE_FAILURE_MESSAGE, granted: true, stage: 'globe' }
  }

  const pushed = await pushTierToGlobe({ email, tier })
  if (!pushed.ok) {
    console.error('[redeem] globe push failed', { userId: user.id, codeId: accessCode.id, tier, failure: pushed.failure })
    await reportGlobeGrantFailure({
      userId: user.id,
      email,
      codeId: accessCode.id,
      tier,
      detail: pushed.detail,
    })
    return { error: GLOBE_FAILURE_MESSAGE, granted: true, stage: 'globe' }
  }

  console.log('[redeem] globe updated', { userId: user.id, tier, detail: pushed.detail })

  console.log('[redeem] success', { userId: user.id, tier: accessCode.tier })

  return { success: true, tier: accessCode.tier }
}
