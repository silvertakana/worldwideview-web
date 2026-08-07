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
 * Best-effort: cancel any LIVE subscription (trialing/active/past_due) across
 * every Stripe customer matching the email. Used at setup/teardown boundaries
 * so leftover subscriptions from prior CI runs (teardown purges globe rows and
 * deletes the Supabase user but historically never cancelled Stripe subs)
 * cannot render the billing page paid for a user that should be free.
 */
export async function cancelStaleSubscriptions(email: string): Promise<void> {
  try {
    // Always hit the real Stripe API for cleanup, NOT stripe-mock.
    // STRIPE_BASE_URL may route test Stripe REST calls to stripe-mock,
    // but subscription cancellation MUST happen against the live Stripe
    // account or stale subs from prior CI runs will never actually be
    // cancelled, causing the billing page to show Pro for free users.
    const base = 'https://api.stripe.com/v1';
    const customersRes = await fetch(`${base}/customers?email=${encodeURIComponent(email)}&limit=10`, {
      headers: stripeHeaders(),
    });
    const customers = await customersRes.json();
    for (const c of customers.data || []) {
      const subsRes = await fetch(`${base}/subscriptions?customer=${c.id}&limit=10`, {
        headers: stripeHeaders(),
      });
      const subs = await subsRes.json();
      for (const s of subs.data || []) {
        if (['trialing', 'active', 'past_due'].includes(s.status)) {
          await fetch(`${base}/subscriptions/${s.id}`, { method: 'DELETE', headers: stripeHeaders() });
          console.log(`[billing-e2e] Cancelled stale subscription ${s.id} (${s.status})`);
        }
      }
    }
  } catch (e) {
    console.log(`[billing-e2e] Stripe cleanup error: ${e}`);
  }
}
