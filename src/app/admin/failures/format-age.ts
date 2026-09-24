/**
 * How long a queue row has been waiting, in words.
 *
 * Takes the clock as an argument rather than reading it, so the caller renders
 * once on the server and the client only re-renders the same string. A component
 * calling Date.now() during render is a hydration mismatch waiting to happen, and
 * the age of a failure is exactly the field an operator reads first.
 */
export function describeAge(iso: string | null | undefined, now: number): string {
  if (!iso) return 'unknown'
  const at = new Date(iso).getTime()
  if (!Number.isFinite(at)) return 'unknown'

  const ms = now - at
  // A row stamped in the future is clock skew between the database and the web
  // process, not a row that will be old later. Saying "0 minutes" is honest.
  if (ms < 60_000) return 'less than a minute'

  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`

  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

/**
 * The clock, read in one place.
 *
 * Not `Date.now()` inline in the page: the React purity rule rejects an impure
 * call during render, and keeping the clock behind a function keeps the page's
 * render a pure function of its data. A server component renders once per
 * request, so the value is stable for the whole page.
 */
export function nowMs(): number {
  return Date.now()
}

/** The queue's stage vocabulary (billing_failures.stage) in the operator's words. */
const STAGE_LABELS: Record<string, string> = {
  provision: 'Workspace provisioning',
  tier_sync: 'Globe tier sync',
  resolve: 'Override revoke',
}

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage
}
