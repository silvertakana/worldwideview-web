// @ts-check
/**
 * The globe's cross-service lock sweep, and the only place in this repo that
 * needs CROSS_SERVICE_SECRET.
 *
 * CROSS_SERVICE_SECRET is NOT a repository secret today (verified against
 * `gh secret list`: the repo has exactly LITELLM_API_KEY, OPENCODE_API_KEY,
 * STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and SUPABASE_DB_URL). Adding it is a
 * human step. Until it exists, a run that finds unpaid-but-granted drift fails
 * here on that specific missing variable rather than silently skipping the
 * sweep: a quietly skipped lock phase looks exactly like a healthy system.
 *
 * THE INTEGRATION POINT BELOW IS DELIBERATELY NOT IMPLEMENTED.
 * `POST /api/service/tier-lock-sweep` is cross-service signed, POST-only, and
 * lives on another branch. Its payload contract has not been read from that
 * branch, and guessing it would mean sending a signed write request the globe
 * might interpret as "lock these workspaces" in a shape nobody agreed on. So
 * this module names the endpoint, names the accounts that need it, and refuses
 * to send anything. Wiring it up is a single edit here, not a change to the
 * reconciler.
 */

/** The globe endpoint this module exists to call. */
export const TIER_LOCK_SWEEP_PATH = '/api/service/tier-lock-sweep'

/**
 * The one environment variable this module needs.
 * @returns {string} the shared HMAC secret
 */
export function requireCrossServiceSecret() {
  const secret = process.env.CROSS_SERVICE_SECRET
  if (!secret) {
    throw new Error(
      'CROSS_SERVICE_SECRET is not set, so the globe lock sweep cannot be requested. ' +
        'The Stripe-to-ledger comparison does not need it and has already finished. ' +
        'Adding it is a human step: repository Settings -> Secrets and variables -> Actions -> ' +
        'New repository secret. Use the same value the globe verifies hub signatures with. ' +
        'Until then, every scheduled run that finds unpaid-but-granted drift will fail here on purpose.',
    )
  }
  return secret
}

/**
 * INTEGRATION POINT. Ask the globe to lock the workspaces belonging to accounts
 * whose payment has stopped.
 *
 * Replace the body with a signed POST to TIER_LOCK_SWEEP_PATH once the globe's
 * payload contract is confirmed. It must stay the only writer this reconciler
 * has; everything else here is read-only.
 *
 * @param {{emails: string[]}} input accounts whose grant is no longer backed by Stripe
 * @returns {Promise<void>}
 */
export async function requestTierLockSweep({ emails }) {
  // Checked first and on purpose: the missing-secret message is the actionable
  // one, so it must win over the not-implemented message.
  requireCrossServiceSecret()

  const accounts = Array.isArray(emails) ? emails.filter(Boolean) : []
  throw new Error(
    `INTEGRATION POINT: POST ${TIER_LOCK_SWEEP_PATH} is not implemented on this branch, so the ` +
      `${accounts.length} account(s) below were NOT locked: ${accounts.join(', ') || '(none)'}. ` +
      'The endpoint is cross-service signed and POST-only and its payload contract lives on another ' +
      'branch; wiring it up is a one-function edit in scripts/lib/globe-tier-lock-sweep.mjs.',
  )
}
