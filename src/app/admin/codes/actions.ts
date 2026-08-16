'use server'

import { revalidatePath } from 'next/cache'
import { randomBytes } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function generateCodeSegment(): string {
  const bytes = randomBytes(5)
  let result = ''
  for (let i = 0; i < 5; i++) {
    result += CODE_CHARS[bytes[i] % CODE_CHARS.length]
  }
  return result
}

function generateSingleCode(): string {
  return `WWV-${generateCodeSegment()}-${generateCodeSegment()}`
}

function adminGuard(user: { app_metadata?: { [key: string]: unknown } } | null): boolean {
  return user?.app_metadata?.role === 'admin'
}

export async function generateCodes(
  quantity: number,
  grantsDays: number,
  notes: string,
  tier: string = 'beta_tester',
): Promise<{ codes: string[]; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!adminGuard(user)) return { codes: [], error: 'Unauthorized' }

  const records = Array.from({ length: quantity }, () => ({
    code: generateSingleCode(),
    grants_days: grantsDays,
    max_uses: 1,
    notes: notes || null,
    created_by: user!.id,
    tier,
  }))

  const { error } = await supabase.from('access_codes').insert(records)
  if (error) return { codes: [], error: error.message }

  revalidatePath('/admin/codes')
  return { codes: records.map(r => r.code) }
}

export async function revokeCode(
  codeId: string,
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!adminGuard(user)) return { success: false, error: 'Unauthorized' }

  const admin = createAdminClient()
  const { error } = await admin
    .from('access_codes')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', codeId)

  if (error) return { success: false, error: error.message }

  await admin
    .from('user_entitlements')
    .update({ revoked_at: new Date().toISOString() })
    .eq('code_id', codeId)
    .is('revoked_at', null)

  revalidatePath('/admin/codes')
  return { success: true }
}

const VALID_TIERS = ['beta_tester', 'early_access', 'pro', 'enterprise'] as const

export async function updateCode(
  codeId: string,
  data: { grants_days?: number; max_uses?: number; tier?: string; notes?: string },
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!adminGuard(user)) return { success: false, error: 'Unauthorized' }

  if (data.grants_days !== undefined && (data.grants_days < 1 || !Number.isInteger(data.grants_days))) {
    return { success: false, error: 'grants_days must be a positive integer' }
  }
  if (data.max_uses !== undefined && (data.max_uses < 1 || !Number.isInteger(data.max_uses))) {
    return { success: false, error: 'max_uses must be a positive integer' }
  }
  if (data.tier !== undefined && !VALID_TIERS.includes(data.tier as typeof VALID_TIERS[number])) {
    return { success: false, error: `tier must be one of: ${VALID_TIERS.join(', ')}` }
  }

  const admin = createAdminClient()
  const updateData: Record<string, string | number | null> = {}
  if (data.grants_days !== undefined) updateData.grants_days = data.grants_days
  if (data.max_uses !== undefined) updateData.max_uses = data.max_uses
  if (data.tier !== undefined) updateData.tier = data.tier
  if (data.notes !== undefined) updateData.notes = data.notes || null

  const { error } = await admin.from('access_codes').update(updateData).eq('id', codeId)
  if (error) return { success: false, error: error.message }

  revalidatePath('/admin/codes')
  return { success: true }
}

export async function unrevokeCode(
  codeId: string,
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!adminGuard(user)) return { success: false, error: 'Unauthorized' }

  const admin = createAdminClient()
  const { error: acError } = await admin
    .from('access_codes')
    .update({ revoked_at: null })
    .eq('id', codeId)

  if (acError) return { success: false, error: acError.message }

  await admin
    .from('user_entitlements')
    .update({ revoked_at: null })
    .eq('code_id', codeId)
    .not('revoked_at', 'is', null)

  revalidatePath('/admin/codes')
  return { success: true }
}

export async function deleteCode(
  codeId: string,
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!adminGuard(user)) return { success: false, error: 'Unauthorized' }

  const admin = createAdminClient()
  const { error: ueError } = await admin
    .from('user_entitlements')
    .delete()
    .eq('code_id', codeId)

  if (ueError) return { success: false, error: ueError.message }

  const { error } = await admin.from('access_codes').delete().eq('id', codeId)
  if (error) return { success: false, error: error.message }

  revalidatePath('/admin/codes')
  return { success: true }
}

export async function bulkRevokeCodes(
  codeIds: string[],
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!adminGuard(user)) return { success: false, error: 'Unauthorized' }

  if (codeIds.length === 0) return { success: false, error: 'No codes selected' }

  const admin = createAdminClient()
  const now = new Date().toISOString()

  const { error: acError } = await admin
    .from('access_codes')
    .update({ revoked_at: now })
    .in('id', codeIds)

  if (acError) return { success: false, error: acError.message }

  await admin
    .from('user_entitlements')
    .update({ revoked_at: now })
    .in('code_id', codeIds)
    .is('revoked_at', null)

  revalidatePath('/admin/codes')
  return { success: true }
}

export async function bulkUnrevokeCodes(
  codeIds: string[],
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!adminGuard(user)) return { success: false, error: 'Unauthorized' }

  if (codeIds.length === 0) return { success: false, error: 'No codes selected' }

  const admin = createAdminClient()

  const { error: acError } = await admin
    .from('access_codes')
    .update({ revoked_at: null })
    .in('id', codeIds)

  if (acError) return { success: false, error: acError.message }

  await admin
    .from('user_entitlements')
    .update({ revoked_at: null })
    .in('code_id', codeIds)

  revalidatePath('/admin/codes')
  return { success: true }
}

export async function bulkDeleteCodes(
  codeIds: string[],
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!adminGuard(user)) return { success: false, error: 'Unauthorized' }

  if (codeIds.length === 0) return { success: false, error: 'No codes selected' }

  const admin = createAdminClient()

  const { error: ueError } = await admin
    .from('user_entitlements')
    .delete()
    .in('code_id', codeIds)

  if (ueError) return { success: false, error: ueError.message }

  const { error } = await admin.from('access_codes').delete().in('id', codeIds)
  if (error) return { success: false, error: error.message }

  revalidatePath('/admin/codes')
  return { success: true }
}
