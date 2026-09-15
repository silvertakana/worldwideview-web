'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/admin'
import { invalidateBillingKillSwitchCache } from '@/lib/billing/kill-switch'

/**
 * Pause or resume NEW purchases.
 *
 * `paused` is written to the single `billing_control` row and mirrored into the
 * `billing_control_events` audit trail. The reason is mandatory: an unlogged
 * flip of the money switch is worse than no flip at all.
 */
export async function setBillingPaused(
  paused: boolean,
  reason: string,
): Promise<{ success: boolean; error?: string }> {
  const user = await requireAdmin()

  const trimmedReason = reason.trim()
  if (trimmedReason.length === 0) {
    return { success: false, error: 'A reason is required' }
  }

  const admin = createAdminClient()

  // The migration seeds exactly one row; a miss means it never ran.
  const { data: row, error: readError } = await admin
    .from('billing_control')
    .select('id')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (readError) {
    return { success: false, error: readError.message }
  }
  if (!row) {
    return {
      success: false,
      error:
        'No billing_control row found. Apply the billing kill switch migration before using this control.',
    }
  }

  const { error: updateError } = await admin
    .from('billing_control')
    .update({
      billing_paused: paused,
      reason: trimmedReason,
      paused_by: user.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id)

  if (updateError) {
    return { success: false, error: updateError.message }
  }

  const { error: auditError } = await admin.from('billing_control_events').insert({
    action: paused ? 'pause' : 'resume',
    reason: trimmedReason,
    actor_user_id: user.id,
  })

  // This invalidates the in-process cache only for the worker that handled the
  // request. Production runs `pm2-runtime server.js -i 4`, so the other workers
  // keep serving the cached value until the 10-second TTL lapses: "instant"
  // means "within 10 seconds".
  invalidateBillingKillSwitchCache()

  // Revalidated as soon as the flag moved, and not only on full success: on the
  // audit-failure path below the state HAS changed, so the page must show the
  // new flag rather than a stale one next to an error about the trail.
  revalidatePath('/admin/billing')
  revalidatePath('/admin')

  if (auditError) {
    // The flag is already flipped, so the state and the trail now disagree.
    // Reporting success would hide an incomplete audit trail from the operator;
    // surface the failure instead and let them re-check the page.
    console.error(
      '[billing] billing_control_events insert failed after a successful flip:',
      auditError.message,
    )
    return {
      success: false,
      error: `Billing was ${paused ? 'paused' : 'resumed'}, but the audit entry could not be written: ${auditError.message}`,
    }
  }

  return { success: true }
}
