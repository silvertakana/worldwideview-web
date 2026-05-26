'use server'

import { redirect } from 'next/navigation'
import { createClient } from '../../lib/supabase/server'
import { createAdminClient } from '../../lib/supabase/admin'

export async function signOut() {
  const supabase = await createClient()
  // Clears the session cookie on the parent domain (ADR-003D) so every
  // subdomain is de-authenticated, not just this one.
  await supabase.auth.signOut()
  redirect('/login')
}

export async function updateDisplayName(
  formData: FormData,
): Promise<{ success: boolean; error?: string }> {
  const displayName = String(formData.get('displayName') ?? '').trim()
  const supabase = await createClient()
  const { error } = await supabase.auth.updateUser({ data: { display_name: displayName } })
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function deleteAccount(): Promise<{ success: boolean; error?: string } | void> {
  const supabase = await createClient()
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser()

  if (!user || userError) {
    redirect('/login')
  }

  const userId = user.id
  const adminClient = createAdminClient()
  const { error } = await adminClient.auth.admin.deleteUser(userId)

  if (error) return { success: false, error: error.message }

  await supabase.auth.signOut()
  redirect('/')
}
