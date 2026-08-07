/* eslint-disable no-console */

/**
 * Shared Stripe REST helpers for the billing E2E suite (no CLI, no
 * interactive confirmation / TTY dependency).
 *
 * STRIPE_BASE_URL lets the test stack point these at stripe-mock; defaults to
 * real Stripe test mode.
 */
export const STRIPE_BASE = process.env.STRIPE_BASE_URL || 'https://api.stripe.com/v1';

export function stripeHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY || ''}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

/**
 * Best-effort: cancel every NON-TERMINAL subscription across EVERY Stripe
 * customer matching the email. Used at setup/teardown boundaries so leftover
 * subscriptions from prior CI runs (teardown purges globe rows and deletes the
 * Supabase user but historically never cancelled Stripe subs) cannot render
 * the billing page paid for a user that should be free.
 *
 * Strengthened for shared-test-account residue (CI run 31159531231):
 *   - iterates ALL customers matching the email (paginated), not just the
 *     first 10 — a shared CI Stripe account accumulates recycled-email
 *     customers across runs;
 *   - cancels every subscription whose status is NOT already terminal
 *     (canceled / incomplete_expired), not just trialing/active/past_due.
 *     A no-metadata stale customer with a live sub is exactly what makes
 *     getHubTierFallback's email fallback return "pro" for a brand-new free
 *     user: the guard at tier-fallback.ts only rejects email matches carrying
 *     a *different* userId, so a customer with NO metadata.userId at all
 *     passes through and its live sub renders as paid.
 */
export async function cancelStaleSubscriptions(email: string): Promise<void> {
  try {
    // Always hit the real Stripe API for cleanup, NOT stripe-mock.
    // STRIPE_BASE_URL may route test Stripe REST calls to stripe-mock,
    // but subscription cancellation MUST happen against the live Stripe
    // account or stale subs from prior CI runs will never actually be
    // cancelled, causing the billing page to show Pro for free users.
    const base = 'https://api.stripe.com/v1';
    const TERMINAL_STATUSES = new Set(['canceled', 'incomplete_expired']);

    // List ALL customers matching the email (paginated).
    const customers: Array<{ id: string }> = [];
    let customersAfter: string | undefined;
    for (;;) {
      const params = new URLSearchParams({ email, limit: '100' });
      if (customersAfter) params.set('starting_after', customersAfter);
      const res = await fetch(`${base}/customers?${params.toString()}`, { headers: stripeHeaders() });
      const body = await res.json();
      const batch: Array<{ id: string }> = body.data || [];
      customers.push(...batch);
      if (!body.has_more || batch.length === 0) break;
      customersAfter = batch[batch.length - 1].id;
    }

    for (const c of customers) {
      // List ALL subscriptions for the customer (paginated).
      const subs: Array<{ id: string; status: string }> = [];
      let subsAfter: string | undefined;
      for (;;) {
        const params = new URLSearchParams({ customer: c.id, limit: '100' });
        if (subsAfter) params.set('starting_after', subsAfter);
        const res = await fetch(`${base}/subscriptions?${params.toString()}`, { headers: stripeHeaders() });
        const body = await res.json();
        const batch: Array<{ id: string; status: string }> = body.data || [];
        subs.push(...batch);
        if (!body.has_more || batch.length === 0) break;
        subsAfter = batch[batch.length - 1].id;
      }

      for (const s of subs) {
        if (TERMINAL_STATUSES.has(s.status)) continue;
        await fetch(`${base}/subscriptions/${s.id}`, { method: 'DELETE', headers: stripeHeaders() });
        console.log(`[billing-e2e] Cancelled stale subscription ${s.id} (${s.status}) for customer ${c.id}`);
      }
    }
  } catch (e) {
    console.log(`[billing-e2e] Stripe cleanup error: ${e}`);
  }
}
