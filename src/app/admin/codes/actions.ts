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
    .delete()
    .eq('code_id', codeId)
    .eq('used_for_instance', false)

  revalidatePath('/admin/codes')
  return { success: true }
}
