'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { resolveFailure } from '@/lib/billing/records'

const FAILURES_PATH = '/admin/failures'

/**
 * Same authorization shape as /admin/codes/actions.ts and
 * /admin/overrides/actions.ts: `requireAdmin()` guards the PAGE, but a server
 * action is reachable without ever rendering it, so the role check is repeated.
 */
function adminGuard(user: { app_metadata?: { [key: string]: unknown } } | null): boolean {
  return user?.app_metadata?.role === 'admin'
}

export type ResolveFailureResult = { ok: true } | { ok: false; error: string }

/**
 * Marks one queue row handled.
 *
 * It closes the row and nothing else: it does not retry the failed step, because
 * the remedy differs per stage (a globe tier-sync is re-pushed from
 * /admin/overrides, a provisioning failure is not) and a single "retry everything"
 * button would be a second, weaker write path next to the ones that already
 * exist. `resolveFailure()` in src/lib/billing/records.ts is the only writer here,
 * the same one retryManualOverridePush closes its own rows with.
 */
export async function resolveFailureAction(failureId: string): Promise<ResolveFailureResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!adminGuard(user)) return { ok: false, error: 'Unauthorized' }

  if (!failureId) return { ok: false, error: 'No failure row was selected.' }

  try {
    await resolveFailure(failureId)
  } catch (err) {
    return { ok: false, error: `Could not close it: ${err instanceof Error ? err.message : String(err)}` }
  }

  revalidatePath(FAILURES_PATH)
  return { ok: true }
}
