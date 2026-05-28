'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import type { UserIdentity } from '@supabase/supabase-js'
import { createClient } from '../../lib/supabase/server'
import { createAdminClient } from '../../lib/supabase/admin'

const ALLOWED_AVATAR_PREFIXES = [
  'data:image/jpeg;base64,',
  'data:image/png;base64,',
  'data:image/webp;base64,',
] as const

const AVATAR_MAX_LENGTH = 35_000
const AVATARS_BUCKET = 'avatars'

export async function signOut() {
  const supabase = await createClient()
  // Clears the session cookie on the parent domain (ADR-003D) so every
  // subdomain is de-authenticated, not just this one.
  await supabase.auth.signOut()
  redirect('/login')
}

/**
 * Uploads a new avatar to Supabase Storage and updates the user's avatar_url
 * in user_metadata with the resulting public storage URL.
 *
 * Storing only the public URL (not the raw base64) keeps session cookies small.
 * Base64 data URLs stored directly in user_metadata inflate every Cookie header
 * and trigger HTTP 431 "Request Header Fields Too Large" from Node.js.
 *
 * @param dataUrl - A data URL (JPEG, PNG, or WebP) produced by client-side canvas resize.
 * @returns The public storage URL of the uploaded avatar.
 */
export async function updateAvatar(dataUrl: string): Promise<{ publicUrl: string }> {
  if (dataUrl.startsWith('https://') || dataUrl.startsWith('http://')) {
    throw new Error('External URLs are not allowed. Upload an image file instead.')
  }
  const isAllowed = ALLOWED_AVATAR_PREFIXES.some((prefix) => dataUrl.startsWith(prefix))
  if (!isAllowed) {
    throw new Error('Invalid image format. Only JPEG, PNG, and WebP are accepted.')
  }
  if (dataUrl.length > AVATAR_MAX_LENGTH) {
    throw new Error('Image is too large. Please use an image under 26 KB.')
  }

  const supabase = await createClient()
  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError || !user) throw new Error('Not authenticated')

  // Decode data URL into raw bytes for storage upload.
  const commaIdx = dataUrl.indexOf(',')
  const meta = dataUrl.slice(0, commaIdx) // e.g. "data:image/jpeg;base64"
  const b64 = dataUrl.slice(commaIdx + 1)
  const mimeType = meta.replace('data:', '').replace(';base64', '') as 'image/jpeg' | 'image/png' | 'image/webp'
  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg'
  const fileBuffer = Buffer.from(b64, 'base64')

  const adminClient = createAdminClient()

  // Ensure the bucket exists (ignored when already present).
  const { error: bucketErr } = await adminClient.storage.createBucket(AVATARS_BUCKET, { public: true })
  if (bucketErr && !/already exist/i.test(bucketErr.message)) {
    throw new Error(`Failed to initialize avatar storage: ${bucketErr.message}`)
  }

  // Upload binary to storage, overwriting any previous avatar for this user.
  const storagePath = `${user.id}/avatar.${ext}`
  const { error: uploadError } = await adminClient.storage
    .from(AVATARS_BUCKET)
    .upload(storagePath, fileBuffer, { contentType: mimeType, upsert: true })
  if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`)

  // Append a timestamp for cache-busting (CDN won't serve stale avatar on re-upload).
  const { data: { publicUrl } } = adminClient.storage.from(AVATARS_BUCKET).getPublicUrl(storagePath)
  const urlWithBuster = `${publicUrl}?t=${Date.now()}`

  // Store only the short URL in user metadata -- not the base64 blob.
  const { error } = await supabase.auth.updateUser({ data: { avatar_url: urlWithBuster } })
  if (error) throw new Error(error.message)

  revalidatePath('/accounts')
  return { publicUrl: urlWithBuster }
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
  let adminClient
  try {
    adminClient = createAdminClient()
  } catch (err) {
    console.error('[deleteAccount] Admin client unavailable:', err instanceof Error ? err.message : err)
    return { success: false, error: 'Account deletion is temporarily unavailable. Please contact support.' }
  }
  const { error } = await adminClient.auth.admin.deleteUser(userId)

  if (error) return { success: false, error: error.message }

  // Best-effort marketplace cleanup. The Supabase user is already deleted at this point,
  // so if this call fails we log and continue -- the account is effectively gone.
  const marketplaceUrl = process.env.MARKETPLACE_INTERNAL_URL
  const marketplaceSecret = process.env.MARKETPLACE_INTERNAL_SECRET
  if (marketplaceUrl && marketplaceSecret) {
    try {
      const res = await fetch(`${marketplaceUrl}/api/internal/delete-user`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${marketplaceSecret}`,
        },
        body: JSON.stringify({ supabaseUserId: userId }),
      })
      if (!res.ok) {
        console.error('[deleteAccount] Marketplace cleanup returned', res.status)
      }
    } catch (err) {
      console.error('[deleteAccount] Marketplace cleanup failed:', err)
    }
  } else {
    console.warn('[deleteAccount] MARKETPLACE_INTERNAL_URL or MARKETPLACE_INTERNAL_SECRET not set -- skipping marketplace cleanup')
  }

  await supabase.auth.signOut()
  redirect('/')
}

export async function getIdentities(): Promise<UserIdentity[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUserIdentities()
  if (error) throw error
  return data?.identities ?? []
}

export async function startGitHubLink(redirectTo: string): Promise<string> {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.linkIdentity({
    provider: 'github',
    options: { redirectTo, skipBrowserRedirect: true },
  })
  if (error) throw error
  if (!data?.url) throw new Error('No OAuth URL returned from Supabase')
  return data.url
}
