'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '../../lib/supabase/server'
import { createAdminClient } from '../../lib/supabase/admin'

const ALLOWED_AVATAR_PREFIXES = [
  'data:image/jpeg;base64,',
  'data:image/png;base64,',
  'data:image/webp;base64,',
] as const

const AVATAR_MAX_LENGTH = 35_000

export async function signOut() {
  const supabase = await createClient()
  // Clears the session cookie on the parent domain (ADR-003D) so every
  // subdomain is de-authenticated, not just this one.
  await supabase.auth.signOut()
  redirect('/login')
}

/**
 * Persists a new avatar for the currently authenticated user.
 *
 * Accepts only JPEG, PNG, or WebP data URLs capped at 35,000 characters.
 * External https:// URLs are rejected -- OAuth provider photos are set
 * directly via user_metadata.avatar_url by Supabase and never pass through
 * this action.
 *
 * @param avatarUrl - A data URL (JPEG, PNG, or WebP) produced by client-side canvas resize.
 * @throws When the user is not authenticated, the URL is invalid, or the Supabase update fails.
 */
export async function updateAvatar(avatarUrl: string): Promise<void> {
  // Reject https:// URLs (OAuth provider photos go directly via user_metadata.avatar_url
  // set by Supabase -- they never pass through this action).
  if (avatarUrl.startsWith('https://') || avatarUrl.startsWith('http://')) {
    throw new Error('External URLs are not allowed. Upload an image file instead.')
  }
  // Accept only JPEG, PNG, or WebP data URLs.
  const isAllowed = ALLOWED_AVATAR_PREFIXES.some((prefix) => avatarUrl.startsWith(prefix))
  if (!isAllowed) {
    throw new Error('Invalid image format. Only JPEG, PNG, and WebP are accepted.')
  }
  // Cap at 35,000 chars (~26 KB decoded) to block oversized payloads.
  if (avatarUrl.length > AVATAR_MAX_LENGTH) {
    throw new Error('Image is too large. Please use an image under 26 KB.')
  }
  const supabase = await createClient()
  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError || !user) throw new Error('Not authenticated')
  const { error } = await supabase.auth.updateUser({ data: { avatar_url: avatarUrl } })
  if (error) throw new Error(error.message)
  revalidatePath('/accounts')
}

export async function updateDisplayName(
  formData: FormData,
): Promise<{ success: boolean; error?: string }> {
  const displayName = String(formData.get('displayName') ?? '').trim()
  if (displayName.length > 60) {
    return { success: false, error: 'Display name must be 60 characters or fewer.' }
  }
  const supabase = await createClient()
  const { error } = await supabase.auth.updateUser({ data: { display_name: displayName } })
  if (error) return { success: false, error: error.message }
  revalidatePath('/accounts')
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
