'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function redeemCode(code: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  // nosemgrep: semgrep.unsanitized-redirect - hardcoded path, not user-controlled
  if (!user) redirect('/login?next=/redeem')

  const trimmed = code.trim()
  if (!trimmed) return { error: 'Please enter an access code' }

  const admin = createAdminClient()

  const { data: accessCode, error: codeError } = await admin
    .from('access_codes')
    .select('*')
    .ilike('code', trimmed)
    .is('revoked_at', null)
    .single()

  if (codeError || !accessCode) {
    return { error: 'Invalid, expired, or already used code' }
  }

  if (accessCode.expires_at && new Date(accessCode.expires_at) <= new Date()) {
    return { error: 'Invalid, expired, or already used code' }
  }

  if (accessCode.use_count >= accessCode.max_uses) {
    return { error: 'Invalid, expired, or already used code' }
  }

  const { error: insertError } = await admin
    .from('user_entitlements')
    .insert({
      user_id: user.id,
      code_id: accessCode.id,
      source: 'access_code',
      grants_days: accessCode.grants_days,
    })

  if (insertError) return { error: 'Failed to redeem code. Please try again.' }

  const { data: updated } = await admin
    .from('access_codes')
    .update({ use_count: accessCode.use_count + 1 })
    .eq('id', accessCode.id)
    .lt('use_count', accessCode.max_uses)
    .select()

  if (!updated || updated.length === 0) {
    return { error: 'Code was just redeemed by someone else. Please try again.' }
  }

  // nosemgrep: semgrep.unsanitized-redirect - hardcoded path, not user-controlled
  redirect('/accounts/instances')
}
