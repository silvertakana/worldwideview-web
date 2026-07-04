'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { crossServiceFetch } from '@/lib/cross-service/fetch'
import { redirect } from 'next/navigation'

export async function redeemCode(code: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'You must be signed in to redeem a code.' }

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

  // Remove any existing unused entitlement for this user (allows re-redemption)
  await admin
    .from('user_entitlements')
    .delete()
    .eq('user_id', user.id)
    .eq('used_for_instance', false)

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

  try {
    const res = await crossServiceFetch('/api/access-code', {
      method: 'POST',
      body: { code: accessCode.code, userId: user.id },
    })
    if (!res.ok) {
      const errorBody = await res.text()
      console.error('Globe Account creation failed:', res.status, errorBody)
    }
  } catch (err) {
    console.error('Failed to reach globe for Account creation:', err)
  }

  // nosemgrep: semgrep.unsanitized-redirect - hardcoded path, not user-controlled
  redirect('/accounts/instances')
}
