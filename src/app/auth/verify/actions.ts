'use server'

import { createClient } from '../../../lib/supabase/server'

export async function verifyEmail(
  code: string,
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) return { success: false, error: error.message }
  return { success: true }
}
