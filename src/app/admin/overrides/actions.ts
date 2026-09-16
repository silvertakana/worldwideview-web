'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { findCustomer, type LookupResult } from '@/lib/billing/customer-lookup'
import { readGlobeTier } from '@/lib/billing/globe-sync'
import {
  grantManualOverride,
  retryManualOverridePush,
  revokeManualOverride,
  type GrantOverrideResult,
  type RetryPushResult,
  type RevokeOverrideResult,
} from '@/lib/billing/manual-override'

const OVERRIDES_PATH = '/admin/overrides'

/**
 * Same authorization shape as /admin/codes/actions.ts. `requireAdmin()` guards
 * the page, but a server action is reachable without ever rendering it, so the
 * role check is repeated here. A non-admin gets 404 from the page and
 * 'Unauthorized' from every action.
 */
function adminGuard(user: { app_metadata?: { [key: string]: unknown } } | null): boolean {
  return user?.app_metadata?.role === 'admin'
}

async function currentAdmin(): Promise<{ id: string; email: string | null } | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!adminGuard(user)) return null
  return { id: user!.id, email: user!.email ?? null }
}

const UNAUTHORIZED = 'Unauthorized'

/**
 * Resolves what the operator typed and reads the globe's own view of the
 * customer. The globe read happens here rather than after a grant so the screen
 * can say "this customer has no globe organization" before anything is written.
 */
export async function lookupCustomer(query: string): Promise<LookupResult> {
  if (!(await currentAdmin())) return { ok: false, error: UNAUTHORIZED }

  const found = await findCustomer(query)
  if (!found.ok) return found

  return { ok: true, customer: found.customer, globe: await readGlobeTier(found.customer.email) }
}

export async function grantOverride(input: {
  userId: string
  email: string
  tier: string
  reason: string
}): Promise<GrantOverrideResult> {
  const admin = await currentAdmin()
  if (!admin) return { ok: false, stage: 'unauthorized', error: UNAUTHORIZED }

  const result = await grantManualOverride({ ...input, createdBy: admin.id })
  revalidatePath(OVERRIDES_PATH)
  return result
}

export async function revokeOverrideAction(input: {
  userId: string
  email: string
  overrideId: string
}): Promise<RevokeOverrideResult> {
  const admin = await currentAdmin()
  if (!admin) return { ok: false, stage: 'unauthorized', error: UNAUTHORIZED }

  const result = await revokeManualOverride({ ...input, revokedBy: admin.id })
  revalidatePath(OVERRIDES_PATH)
  return result
}

/** Offered after a grant whose globe push failed. The hub half is already recorded. */
export async function retryGlobePush(input: {
  userId: string
  email: string
  tier: string
}): Promise<RetryPushResult> {
  const admin = await currentAdmin()
  if (!admin) return { ok: false, stage: 'unauthorized', error: UNAUTHORIZED }

  const result = await retryManualOverridePush(input)
  revalidatePath(OVERRIDES_PATH)
  return result
}
