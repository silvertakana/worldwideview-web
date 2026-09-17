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
 * Stripe TEST card numbers. Public, non-secret identifiers — safe to commit.
 * The success card is the suite default; the decline card drives the decline
 * scenario. See fillStripeCard in billing-flow.spec.ts for the env override.
 */
export const STRIPE_CARD_SUCCESS = '4242424242424242';
export const STRIPE_CARD_DECLINE = '4000000000000002';

/**
 * The single-use test token that maps to the decline card.
 *
 * Stripe refuses raw card numbers on the API ("Sending credit card numbers
 * directly to the Stripe API is generally unsafe") unless raw-card-data access
 * is explicitly enabled on the account, so the decline is driven through the
 * documented test token instead. `tok_chargeDeclined` is Stripe's canonical
 * always-declined card (the 4000 0000 0000 0002 number above).
 */
export const STRIPE_TOKEN_CHARGE_DECLINED = 'tok_chargeDeclined';

/**
 * The card the suite types into hosted checkout.
 *
 * Defaults to the success card, so every pre-existing test is unchanged when
 * STRIPE_TEST_CARD is unset. Set it to drive a different test card without
 * editing the spec.
 */
export function testCardNumber(): string {
  return process.env.STRIPE_TEST_CARD || STRIPE_CARD_SUCCESS;
}

/** Stripe's hosted form displays card numbers grouped in fours. */
export function formatCardNumber(digits: string): string {
  return digits.replace(/(.{4})/g, '$1 ').trim();
}

/**
 * The Stripe customer for an email, created on first use. Shared so the
 * period-end and decline scenarios agree on which customer they bill.
 */
export async function findOrCreateCustomer(email: string, name: string): Promise<string> {
  const customersRes = await fetch(`${STRIPE_BASE}/customers?email=${encodeURIComponent(email)}&limit=10`, {
    headers: stripeHeaders(),
  });
  const customers = await customersRes.json();
  const existing = (customers.data || []).find(
    (c: { email: string; id: string }) => c.email === email,
  );
  if (existing) return existing.id as string;

  const createRes = await fetch(`${STRIPE_BASE}/customers`, {
    method: 'POST',
    headers: stripeHeaders(),
    body: new URLSearchParams({ email, name }).toString(),
  });
  const created = await createRes.json();
  if (!createRes.ok || !created.id) {
    throw new Error(`stripe customer create failed: ${JSON.stringify(created).slice(0, 120)}`);
  }
  return created.id as string;
}

/** Every subscription id on a customer, sorted so two reads compare cleanly. */
export async function listSubscriptionIds(customerId: string): Promise<string[]> {
  const res = await fetch(`${STRIPE_BASE}/subscriptions?customer=${customerId}&limit=100`, {
    headers: stripeHeaders(),
  });
  const body = await res.json();
  const ids = ((body.data || []) as Array<{ id: string }>).map((s) => s.id);
  return ids.sort();
}

/** The outcome of a declined-card payment attempt, as Stripe reported it. */
export interface DeclineResult {
  ok: boolean;
  code: string | null;
  declineCode: string | null;
  message: string | null;
}

/**
 * Drive the decline card and attempt a real charge, returning Stripe's verdict
 * instead of throwing.
 *
 * A decline is NOT observable when a card is merely stored: Stripe accepts the
 * number and only rejects it when money actually moves. The card is therefore
 * materialized as a payment method and then USED for a confirmed off-session
 * PaymentIntent, which is where Stripe returns `card_declined`.
 *
 * `cardNumber` is accepted for readability at the call site and must equal the
 * decline card's number; the account blocks raw card data, so the number is
 * mapped to Stripe's documented test token rather than sent verbatim.
 *
 * Doing this over the REST API is what makes the decline reachable without a
 * browser, and therefore without the hosted page's hCaptcha (see the spec's
 * Test 5 notes).
 */
export async function attemptPaymentWithCard(
  customerId: string,
  cardNumber: string,
): Promise<DeclineResult> {
  if (cardNumber !== STRIPE_CARD_DECLINE) {
    throw new Error(
      `attemptPaymentWithCard drives the decline path only; got card ${cardNumber}`,
    );
  }

  const pmRes = await fetch(`${STRIPE_BASE}/payment_methods`, {
    method: 'POST',
    headers: stripeHeaders(),
    body: new URLSearchParams({
      type: 'card',
      'card[token]': STRIPE_TOKEN_CHARGE_DECLINED,
    }).toString(),
  });
  const pm = await pmRes.json();
  if (!pmRes.ok || !pm.id) {
    return {
      ok: false,
      code: pm?.error?.code ?? null,
      declineCode: pm?.error?.decline_code ?? null,
      message: pm?.error?.message ?? 'payment method creation failed',
    };
  }

  const attachRes = await fetch(`${STRIPE_BASE}/payment_methods/${pm.id}/attach`, {
    method: 'POST',
    headers: stripeHeaders(),
    body: new URLSearchParams({ customer: customerId }).toString(),
  });
  if (!attachRes.ok) {
    const attached = await attachRes.json();
    return {
      ok: false,
      code: attached?.error?.code ?? null,
      declineCode: attached?.error?.decline_code ?? null,
      message: attached?.error?.message ?? 'payment method attach failed',
    };
  }

  // Confirm the charge against the stored card. Stripe rejects the DECLINE card
  // here; a success card would return `succeeded`. Off-session confirmation
  // mirrors the merchant-initiated billing a declined renewal would hit.
  const piRes = await fetch(`${STRIPE_BASE}/payment_intents`, {
    method: 'POST',
    headers: stripeHeaders(),
    body: new URLSearchParams({
      amount: '1900',
      currency: 'usd',
      customer: customerId,
      payment_method: pm.id as string,
      confirm: 'true',
      off_session: 'true',
    }).toString(),
  });
  const pi = await piRes.json();
  console.log(
    `[billing] decline-card charge attempt -> ${piRes.status}, code=${pi?.error?.code ?? pi?.status ?? 'none'}`,
  );

  if (piRes.ok && !pi?.error) {
    return { ok: true, code: null, declineCode: null, message: null };
  }

  return {
    ok: false,
    code: pi?.error?.code ?? null,
    declineCode: pi?.error?.decline_code ?? null,
    message: pi?.error?.message ?? null,
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
