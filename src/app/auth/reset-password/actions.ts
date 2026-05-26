'use server'

import { createClient } from '../../../lib/supabase/server'

export async function requestPasswordReset(
  formData: FormData,
): Promise<{ success: boolean; email?: string; error?: string }> {
  const email = String(formData.get('email') ?? '').trim()
  const supabase = await createClient()
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? ''
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: siteUrl + '/auth/reset-password/confirm',
  })
  // Even if the email does not exist, show success to prevent email enumeration.
  if (error) return { success: false, error: 'Something went wrong. Please try again.' }
  return { success: true, email }
}
