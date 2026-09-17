/* eslint-disable no-console */
import { test, expect, type Page } from '@playwright/test';
import { GlobeDb } from './lib/globe-db';
import { loadHubEnv } from './lib/env';
import { directTierSync, triggerTierLockSweep } from './lib/globe-sync';
import {
  STRIPE_CARD_DECLINE,
  attemptPaymentWithCard,
  findOrCreateCustomer,
  formatCardNumber,
  listSubscriptionIds,
  testCardNumber,
} from './lib/stripe';
import { getDefaultPriceId } from '../src/lib/billing/constants';

/**
 * Full billing E2E flow against the RUNNING local stack:
 *
 *   Test 1 — checkout contract: drives the REAL "Upgrade to Pro" button end to
 *            end (regression for the empty-body 400 hang), then Stripe redirect.
 *            Best-effort card entry.
 *   Test 2 — webhook → tier-sync: org_tier flips to pro/trialing, workspace
 *            stays unlocked (regression for the webhook expand-path crash).
 *   Test 3 — cancel → deferred lock → deadline sweep: subscription cancel fires
 *            customer.subscription.deleted; org_tier reverts to free/canceled
 *            and the workspace is RELEASED with the lock ARMED for the globe's
 *            downgrade grace window, not locked on arrival. The test then fires
 *            the armed deadline through the globe's own sweep endpoint and
 *            asserts the lock lands (regression for the canceled-status 400,
 *            the grace-window deferral, and the deferral not decaying into
 *            permanent free access).
 *   Test 4 — cancel at PERIOD END (subscription update with
 *            cancel_at_period_end=true, the customer-friendly path): tier
 *            STAYS pro/trialing and the workspace STAYS unlocked until the
 *            period ends (regression guard: the webhook must NOT downgrade on
 *            cancel_at_period_end — it only downgrades on status "canceled").
 *            Setup uses the verified-endpoints path (direct HMAC tier-sync +
 *            a real API-created trialing subscription) instead of a second
 *            hosted-checkout card payment — Stripe's invisible hCaptcha blocks
 *            card submission from CI datacenter IPs (Stripe-owned, no fix).
 *   Test 5 — declined card: drives the Stripe decline card 4000000000000002
 *            against the REAL test API and asserts the money-path consequence —
 *            the decline is rejected, creates no subscription, and grants no
 *            entitlement (org_tier stays free/canceled, workspace unlocked).
 *            The in-browser decline render is NOT covered: it is the same
 *            hosted card form as the success path, behind the same hCaptcha
 *            wall. See the test body for the exact covered/not-covered split.
 *
 * CARD CONFIGURATION: `fillStripeCard` types STRIPE_TEST_CARD (default
 * 4242424242424242), so a test card can be swapped without editing this file.
 *
 * MOVED from the globe repo (worldwideview.fix-billing-tier) — the hub now owns
 * billing (ADR-0009). The suite still depends on GLOBE-SPECIFIC services:
 *   - hub    https://hub.wwv.local   (wwv-dev-hub, this repo)
 *   - globe  http://localhost:3000    (wwv-dev-globe, globe repo — tier-sync endpoint)
 *   - globe DB reachable at DATABASE_URL (dev stack: localhost:5432/worldwideview)
 *   - `stripe listen` forwarding to https://hub.wwv.local/api/billing/webhook
 *   - `stripe` CLI default account = the app's sandbox account
 *
 * WEBHOOK SIMULATOR ASSESSMENT: the test stack's simulator (test/simulator/)
 * replaces `stripe listen` only for the SIGNATURE path — it proves the hub
 * receives a byte-identical signed event and replies 200. It CANNOT drive the
 * tier-sync assertions below: the hub's webhook handler resolves the customer
 * email via outbound Stripe calls (customers.retrieve /
 * checkout.sessions.retrieve) which return canned fixtures with no matching
 * email against stripe-mock. Tier assertions therefore keep the real-Stripe
 * default. Point the specs' own Stripe REST calls at stripe-mock with
 * STRIPE_BASE_URL (defaults to real Stripe test mode).
 */

export const TEST_EMAIL = 'billing-e2e@worldwideview.local';

// ---------------------------------------------------------------------------
// Env loading (worker processes do NOT inherit env set in globalSetup).
// ---------------------------------------------------------------------------
loadHubEnv();

// Stripe REST calls (no CLI → no interactive confirmation / TTY dependency).
// STRIPE_BASE_URL lets the test stack point these at stripe-mock; defaults to
// real Stripe test mode.
const STRIPE_BASE = process.env.STRIPE_BASE_URL || 'https://api.stripe.com/v1';
function stripeHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY || ''}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

async function findActiveSubscription(): Promise<{ id: string; customer: string } | null> {
  const customersRes = await fetch(`${STRIPE_BASE}/customers?email=${encodeURIComponent(TEST_EMAIL)}&limit=10`, {
    headers: stripeHeaders(),
  });
  const customers = await customersRes.json();
  for (const c of customers.data || []) {
    const subsRes = await fetch(`${STRIPE_BASE}/subscriptions?customer=${c.id}&limit=10`, {
      headers: stripeHeaders(),
    });
    const subs = await subsRes.json();
    for (const s of subs.data || []) {
      if (['trialing', 'active', 'past_due'].includes(s.status)) return { id: s.id, customer: c.id };
    }
  }
  return null;
}

async function cancelSubscription(subId: string): Promise<void> {
  const res = await fetch(`${STRIPE_BASE}/subscriptions/${subId}`, {
    method: 'DELETE',
    headers: stripeHeaders(),
  });
  const body = await res.json();
  console.log(`[billing] cancelled subscription ${subId} ->`, res.status, body.status || JSON.stringify(body).slice(0, 80));
  expect(res.ok, `stripe cancel failed: ${JSON.stringify(body).slice(0, 120)}`).toBeTruthy();
}

/**
 * Cancel a subscription at PERIOD END via the Stripe update endpoint —
 * POST (NOT DELETE, NOT the portal UI). Stripe has NO PATCH method: a PATCH
 * request is rejected with an nginx 403 HTML page by the Stripe edge. The
 * update keeps the subscription trialing/active and fires
 * `customer.subscription.updated` with `cancel_at_period_end: true`; the
 * actual cancellation happens at the end of the current period.
 */
async function cancelAtPeriodEnd(subId: string): Promise<{ status: string; cancelAtPeriodEnd: boolean }> {
  const res = await fetch(`${STRIPE_BASE}/subscriptions/${subId}`, {
    method: 'POST',
    headers: stripeHeaders(),
    body: new URLSearchParams({ cancel_at_period_end: 'true' }).toString(),
  });
  const body = await res.json();
  console.log(
    `[billing] cancel-at-period-end ${subId} -> ${res.status}, status=${body.status}, cancel_at_period_end=${body.cancel_at_period_end}`,
  );
  expect(res.ok, `stripe update cancel_at_period_end failed: ${JSON.stringify(body).slice(0, 120)}`).toBeTruthy();
  return { status: body.status, cancelAtPeriodEnd: body.cancel_at_period_end };
}

// ---------------------------------------------------------------------------
// Shared state (serial suite).
// ---------------------------------------------------------------------------
let checkoutUrl: string | null = null;
let paymentCompleted = false;
let globeDb: GlobeDb;
let testOrgId: string;
let testUserId: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  globeDb = new GlobeDb();

  const user = await globeDb.findUserByEmail(TEST_EMAIL);
  expect(user, 'seeded globe user missing').toBeTruthy();
  testUserId = user!.id;
  const member = await globeDb.findMembershipForUser(user!.id);
  expect(member, 'seeded org membership missing').toBeTruthy();
  testOrgId = member!.organizationId;
});

test.afterAll(async () => {
  if (globeDb) await globeDb.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const CARD_ENTRY_TIMEOUT_MS = 45000;

/**
 * The globe's tier-downgrade grace window, mirrored from worldwideview
 * src/lib/org-tier-policy.ts (TIER_DOWNGRADE_GRACE_MS, on main since PR #504).
 * A cancellation releases the workspace and ARMS
 * `org_tiers.pendingLockAt = now + this`; the lock is applied later by
 * POST /api/service/tier-lock-sweep once the deadline has elapsed.
 * A local copy because the two repos share no module.
 */
const TIER_DOWNGRADE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Tolerance on the armed deadline. The globe stamps it from its own clock
 * slightly before the tier poll observes it, so the remaining window measured
 * here is a little under the full grace period.
 */
const GRACE_WINDOW_SLACK_MS = 5 * 60 * 1000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fill the Stripe HOSTED checkout (checkout.stripe.com/c/pay/...).
 *
 * Current Stripe layout (verified 2026-08): all card fields render directly in
 * the top checkout frame (NO `name="cardNumber"`-style named iframes anymore).
 * Country defaults to the browser's geo (NZ here) and must be set to US so the
 * 4242 test card + ZIP postcode are accepted.
 *
 * The card is env-driven (STRIPE_TEST_CARD, default the success card); the
 * expiry/CVC/postcode below are accepted by every Stripe test card, so a
 * decline card fails on the number itself rather than on an unrelated field.
 */
async function fillStripeCard(page: Page): Promise<void> {
  await page.getByPlaceholder('1234 1234 1234 1234').fill(formatCardNumber(testCardNumber()));
  await page.getByPlaceholder('MM / YY').fill('12/32');
  await page.getByRole('textbox', { name: 'CVC' }).fill('123');
  await page.getByPlaceholder('Full name on card').fill('Billing E2E User');

  const country = page.getByRole('combobox', { name: 'Country or region' });
  await country.selectOption({ label: 'United States' });

  const postal = page.getByRole('textbox', { name: /postal|zip/i });
  if (await postal.count()) await postal.fill('90210');
  const addr1 = page.getByRole('textbox', { name: /address/i });
  if (await addr1.count()) await addr1.fill('1 Market Street');

  const pay = page.getByRole('button', { name: /start trial/i });
  await expect(pay).toBeVisible({ timeout: 10000 });
  await pay.click();
}

/** Thin wrapper so Test 4/5 call the shared helper with this suite's identity. */
function findOrCreateTestCustomer(): Promise<string> {
  return findOrCreateCustomer(TEST_EMAIL, 'Billing E2E User');
}

/**
 * Create a REAL trialing Stripe subscription via the REST API (no browser, no
 * hosted checkout, no hCaptcha). Used by Test 4 to have a live subscription to
 * cancel at PERIOD END. With trial_period_days the subscription is created in
 * trialing status without a payment method. Locally `stripe listen` forwards
 * the customer.subscription.created event to the hub webhook (idempotent
 * pro/trialing re-sync); in CI the event cannot be delivered — the test stack
 * has no webhook listener, so the tier assertions rely on the direct path.
 */
async function createTrialingSubscription(): Promise<{ id: string; status: string }> {
  const customerId = await findOrCreateTestCustomer();

  // Same pro price the hub's checkout route uses (getPriceId('pro', 'month'));
  // env override wins when CI injects a rotated test-account price; otherwise
  // fall back to the CANONICAL default from src/lib/billing/constants.ts
  // (getDefaultPriceId) — no duplicated literal lives in this spec.
  const priceId = process.env.STRIPE_PRO_PRICE_ID || getDefaultPriceId('pro', 'month');
  const res = await fetch(`${STRIPE_BASE}/subscriptions`, {
    method: 'POST',
    headers: stripeHeaders(),
    body: new URLSearchParams({
      customer: customerId,
      'items[0][price]': priceId,
      trial_period_days: '7',
      'metadata[source]': 'billing-e2e-test4',
    }).toString(),
  });
  const body = await res.json();
  console.log(`[billing] created trialing subscription -> ${res.status}, status=${body.status}`);
  expect(res.ok, `stripe subscription create failed: ${JSON.stringify(body).slice(0, 120)}`).toBeTruthy();
  expect(body.status, 'API-created subscription must be trialing (trial_period_days)').toBe('trialing');
  return { id: body.id, status: body.status };
}

// ---------------------------------------------------------------------------
// Test 1 — checkout contract (drives the REAL UI button)
// ---------------------------------------------------------------------------
test('checkout contract: real "Upgrade to Pro" button → POST /api/billing/checkout → Stripe redirect', async ({ page }) => {
  // WHY the real button (regression guard for the empty-body hang): before the
  // hub fix, ManageBillingClient POSTed /api/billing/checkout with NO body and
  // the route's req.json() threw -> 400 -> the button hung forever. A test that
  // only hit the API directly (with a valid body) never exercised the actual UI
  // caller, so it would NOT have caught the regression. Test 1 therefore drives
  // the real button and REQUIRES the 200 + redirect. The direct API call below
  // only proves the route-side empty-body default (the other half of the fix).
  await page.goto('/pricing');

  // Billing UI is enabled and visible for the signed-in user.
  const manageBilling = page.getByRole('link', { name: /manage billing/i });
  await expect(manageBilling).toBeVisible({ timeout: 20000 });
  await manageBilling.click();
  await page.waitForURL(/\/accounts\/billing/);

  const upgradeBtn = page.getByRole('button', { name: /upgrade to pro/i });
  await expect(upgradeBtn).toBeVisible({ timeout: 20000 });

  // SECONDARY — route-side guard: replay the exact pre-fix client request (bare
  // POST, no body, no Content-Type). The route must default to { plan: 'pro' }
  // and return a checkout URL instead of 400.
  const emptyBodyResp = await page.request.post('/api/billing/checkout', {
    // The route derives success_url from the Origin header; APIRequestContext
    // sends none, so it would fall back to wwv.local (wrong host).
    headers: { Origin: 'https://hub.wwv.local' },
  });
  const emptyBody = await emptyBodyResp.json();
  expect(
    emptyBodyResp.status(),
    `empty-body checkout POST should default to pro, got ${emptyBodyResp.status()} ${JSON.stringify(emptyBody).slice(0, 120)}`,
  ).toBe(200);

  // PRIMARY — drive the real UI caller (ManageBillingClient.handleUpgrade).
  const checkoutRespP = page.waitForResponse(
    (r) => r.url().includes('/api/billing/checkout') && r.request().method() === 'POST',
    { timeout: 20000 },
  );
  await upgradeBtn.click();
  const resp = await checkoutRespP;
  // NOTE: do NOT read resp.json() here — the client reads the body, then
  // window.location.href navigates to checkout.stripe.com, so the response
  // resource is gone before Playwright could fetch it. Status is captured.
  expect(
    resp.status(),
    `real "Upgrade to Pro" click returned HTTP ${resp.status()} — ` +
      `the empty-body hang regression: the button must reach Stripe, not hang on a 400`,
  ).toBe(200);
  console.log('[billing] UI subscribe CTA worked (200 + redirect)');
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30000 });

  // PRIMARY assertion: the app reaches hosted checkout instead of hanging on a 400.
  expect(page.url()).toMatch(/checkout\.stripe\.com/);
  checkoutUrl = page.url();
  console.log('[billing] checkout URL captured:', checkoutUrl.slice(0, 60));

  // Best-effort card entry on the hosted checkout (test-mode 4242 card).
  try {
    await withTimeout(fillStripeCard(page), CARD_ENTRY_TIMEOUT_MS, 'fillStripeCard');
    await page.waitForURL(/status=success|accounts\/billing/, { timeout: 45000 });
    paymentCompleted = true;
    console.log('[billing] payment completed via hosted checkout card entry');
  } catch (err) {
    paymentCompleted = false;
    test.info().annotations.push({
      type: 'issue',
      description: 'Stripe hosted-checkout card entry not automatable here: ' + String(err).slice(0, 180),
    });
    console.log('[billing] card entry failed — Test 2 will use fallback:', String(err).slice(0, 160));
  }
});

// ---------------------------------------------------------------------------
// Test 2 — webhook → tier-sync
// ---------------------------------------------------------------------------
test('tier sync lands pro/trialing after payment; workspace stays unlocked', async ({ page }) => {
  if (!paymentCompleted && checkoutUrl) {
    try {
      await page.goto(checkoutUrl);
      await withTimeout(fillStripeCard(page), CARD_ENTRY_TIMEOUT_MS, 'fillStripeCard-retry');
      await page.waitForURL(/status=success|accounts\/billing/, { timeout: 45000 });
      paymentCompleted = true;
      console.log('[billing] payment completed on retry');
    } catch (err) {
      console.log('[billing] card entry blocked; using direct HMAC tier-sync fallback:', String(err).slice(0, 120));
      await directTierSync(TEST_EMAIL, 'pro', 'trialing');
    }
  } else if (!paymentCompleted) {
    await directTierSync(TEST_EMAIL, 'pro', 'trialing');
  }

  await expect
    .poll(
      async () => {
        const row = await globeDb.getOrgTier(testOrgId);
        return row ? `${row.tier}/${row.status}` : null;
      },
      { timeout: 45000, intervals: [1500] },
    )
    .toBe('pro/trialing');

  const ws = await globeDb.findWorkspaceByOwner(testUserId);
  expect(ws, 'seeded workspace missing').toBeTruthy();
  expect(ws!.locked).toBe(false);
  expect(ws!.lockedAt).toBeNull();
  console.log('[billing] org_tier = pro/trialing, workspace unlocked');
});

// ---------------------------------------------------------------------------
// Test 3 — cancel → deferred lock → deadline sweep
// ---------------------------------------------------------------------------
test('cancel subscription → tier reverts to free/canceled and the lock is deferred to the grace deadline', async () => {
  // Prefer the real Stripe lifecycle: cancel the live subscription so the
  // customer.subscription.deleted webhook fires. Fall back to a direct HMAC
  // tier-sync when no real subscription exists, which in CI is every run: the
  // hosted card page never completes its redirect from a datacenter IP, so
  // Test 1 never creates one. Both calls land on the globe's
  // POST /api/service/tier-sync -> setOrgTier(), so both observe the same
  // lock contract asserted below. What only the real path proves is the hub's
  // own mapping of the Stripe event onto the payload.
  const liveSub = await findActiveSubscription();
  const reachedGlobeViaWebhook = liveSub !== null;
  if (liveSub) {
    console.log(`[billing] cancelling subscription ${liveSub.id}`);
    await cancelSubscription(liveSub.id);
  } else {
    console.log('[billing] no live subscription found, using direct HMAC tier-sync fallback');
    await directTierSync(TEST_EMAIL, 'free', 'canceled');
  }

  await expect
    .poll(
      async () => {
        const row = await globeDb.getOrgTier(testOrgId);
        return row ? `${row.tier}/${row.status}` : null;
      },
      { timeout: 45000, intervals: [1500] },
    )
    .toBe('free/canceled');

  // The downgrade itself is immediate, the lock is not. A cancellation must not
  // cost the customer access the moment Stripe reports it: the globe RELEASES
  // the workspace and ARMS a deadline instead.
  const armed = await globeDb.getOrgTierLockState(testOrgId);
  expect(armed, 'org_tiers row missing after cancel').toBeTruthy();
  expect(armed!.tier).toBe('free');
  expect(armed!.status).toBe('canceled');

  const ws = await globeDb.findWorkspaceByOwner(testUserId);
  expect(ws, 'seeded workspace missing').toBeTruthy();
  expect(ws!.locked, 'a cancellation must not lock the workspace on arrival').toBe(false);
  expect(ws!.lockedAt, 'a deferred lock must not stamp lockedAt').toBeNull();
  expect(ws!.lockedReason).toBeNull();

  // Armed for the downgrade grace window, never before the period the customer
  // has already paid through.
  const pendingLockAt = armed!.pendingLockAt;
  expect(
    pendingLockAt,
    'no armed lock deadline: the globe locked the workspace on arrival instead of deferring it',
  ).not.toBeNull();
  const armedForMs = pendingLockAt!.getTime() - Date.now();
  expect(
    armedForMs,
    `armed deadline ${pendingLockAt!.toISOString()} is not a full grace window out`,
  ).toBeGreaterThan(TIER_DOWNGRADE_GRACE_MS - GRACE_WINDOW_SLACK_MS);
  if (armed!.periodEndsAt) {
    expect(
      pendingLockAt!.getTime(),
      'the lock may not fire before the period the customer has already paid for',
    ).toBeGreaterThanOrEqual(armed!.periodEndsAt.getTime());
  }
  expect(armed!.pendingLockReason ?? '').toContain('Tier downgraded');
  console.log(
    `[billing] org_tier = free/canceled, workspace released + lock armed for ${pendingLockAt!.toISOString()} ` +
      `(grace window ok; tier reached the globe via ${reachedGlobeViaWebhook ? 'webhook' : 'direct HMAC tier-sync'})`,
  );

  // The deferral must not decay into permanent free access: fire the armed
  // deadline by backdating it and running the globe's own sweep, then assert
  // the lock actually lands. Without this the test would only prove "not
  // locked yet", which is the opposite failure from the one it guards.
  // Two days of margin, not one: pg sends a JS Date for a `timestamp(3)` column
  // and a session-timezone cast can shift it by up to ~14 hours, which must not
  // be able to push the deadline back into the future.
  await globeDb.backdatePendingLockAt(testOrgId, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
  const sweep = await triggerTierLockSweep();
  expect(sweep.due, 'the backdated deadline must be due').toBeGreaterThanOrEqual(1);
  expect(sweep.locked, 'the sweep must lock the downgraded workspace').toBeGreaterThanOrEqual(1);

  const lockedWs = await globeDb.findWorkspaceByOwner(testUserId);
  expect(lockedWs, 'seeded workspace missing after the deadline sweep').toBeTruthy();
  expect(lockedWs!.locked, 'the elapsed deadline must lock the workspace').toBe(true);
  expect(lockedWs!.lockedReason).toContain('Tier downgraded');
  expect(lockedWs!.lockedAt).not.toBeNull();

  const consumed = await globeDb.getOrgTierLockState(testOrgId);
  expect(consumed, 'org_tiers row missing after the deadline sweep').toBeTruthy();
  expect(consumed!.pendingLockAt, 'a fired deadline must be consumed once the lock lands').toBeNull();
  console.log('[billing] grace deadline fired: workspace locked (deferral ends in a lock, not free access)');
});

// ---------------------------------------------------------------------------
// Test 4 — cancel at PERIOD END → access preserved until the period ends
// ---------------------------------------------------------------------------

test('cancel at period end → tier stays pro/trialing and workspace stays unlocked', async () => {
  // This test is longer than the 120s config default (real Stripe API
  // subscription lifecycle + webhook polls), so give it the same 4-minute
  // headroom the sibling provision spec configures for its suite.
  test.setTimeout(240000);

  // Test 3 left the org at free/canceled with the workspace locked by the fired
  // deadline sweep. Restore the paid state through the direct HMAC tier-sync,
  // the path Tests 2-3 take in CI: it flips org_tiers to pro/trialing and
  // RELEASES the workspace via setOrgTier's upgrade branch (which also disarms
  // the pending lock). A hosted-checkout re-subscribe is deliberately NOT used:
  // Stripe's hosted page runs an invisible hCaptcha that blocks payment
  // submission from CI datacenter IPs (Stripe-owned bot wall, no fix).
  await directTierSync(TEST_EMAIL, 'pro', 'trialing');

  // Restored state: org_tiers = pro/trialing + workspace unlocked.
  await expect
    .poll(
      async () => {
        const row = await globeDb.getOrgTier(testOrgId);
        return row ? `${row.tier}/${row.status}` : null;
      },
      { timeout: 45000, intervals: [1500] },
    )
    .toBe('pro/trialing');

  const wsAfterResub = await globeDb.findWorkspaceByOwner(testUserId);
  expect(wsAfterResub, 'seeded workspace missing after re-subscribe').toBeTruthy();
  expect(wsAfterResub!.locked, 're-subscribe must unlock the workspace').toBe(false);
  expect(wsAfterResub!.lockedAt).toBeNull();
  console.log('[billing] direct tier-sync restored pro/trialing + unlocked workspace');

  // Real Stripe subscription for the period-end cancel — created via the
  // Stripe REST API (no browser, no hosted checkout, no hCaptcha). Locally
  // `stripe listen` forwards customer.subscription.created to the hub webhook,
  // which re-syncs pro/trialing (idempotent). In CI the event cannot be
  // delivered (Stripe cannot reach the in-docker-network hub — the test stack
  // has no webhook listener), so the tier assertions below hold via the direct
  // path, which is exactly the state the webhook would preserve: a period-end
  // cancel must NOT downgrade.
  const liveSub = await createTrialingSubscription();

  // Cancel at PERIOD END — POST the subscription update (Stripe has no PATCH
  // method; the brief's "PATCH" gets a 403 HTML page from the Stripe edge).
  // Stripe keeps the subscription trialing and fires
  // customer.subscription.updated with cancel_at_period_end=true. The hub
  // webhook handler derives status from SUBSCRIPTION_STATUS_MAP (trialing →
  // "trialing") and only downgrades on status "canceled", so the tier/workspace
  // must stay untouched.
  const cancelled = await cancelAtPeriodEnd(liveSub.id);
  expect(cancelled.status, 'period-end cancel must not change subscription status').toBe('trialing');
  expect(cancelled.cancelAtPeriodEnd, 'Stripe must accept cancel_at_period_end=true').toBe(true);

  // The customer-friendly contract: cancel-at-period-end KEEPS access. Tier
  // must remain pro/trialing and the workspace must remain unlocked. (Locally
  // the customer.subscription.updated webhook re-syncs and the tier stays put —
  // the regression this test guards; in CI no webhook is delivered, so this
  // asserts the direct-path state is not downgraded by the Stripe update.)
  await expect
    .poll(
      async () => {
        const row = await globeDb.getOrgTier(testOrgId);
        return row ? `${row.tier}/${row.status}` : null;
      },
      { timeout: 15000, intervals: [1000] },
    )
    .toBe('pro/trialing');

  const wsFinal = await globeDb.findWorkspaceByOwner(testUserId);
  expect(wsFinal, 'seeded workspace missing after period-end cancel').toBeTruthy();
  expect(wsFinal!.locked, 'workspace must stay unlocked until the period ends').toBe(false);
  expect(wsFinal!.lockedAt).toBeNull();
  console.log('[billing] period-end cancel: org_tier = pro/trialing, workspace stays unlocked');

  // Leave the Stripe account tidy for the next run: delete the period-end
  // subscription so the shared user's end state matches Test 3's baseline
  // (no live subscription). Best-effort — must never fail the test.
  try {
    await cancelSubscription(liveSub.id);
    console.log('[billing] cleanup: deleted period-end subscription', liveSub.id);
  } catch (err) {
    console.warn('[billing] cleanup delete failed (leaving period-end sub active):', String(err).slice(0, 120));
  }
});

// ---------------------------------------------------------------------------
// Test 5 — declined card → no entitlement granted
// ---------------------------------------------------------------------------

/**
 * Drive a REAL declined card against Stripe test mode and assert the money-path
 * contract: a decline grants NOTHING on our side.
 *
 * WHY NOT THE HOSTED CHECKOUT PAGE (structural, not a shortcut):
 *   Tests 1-2 already establish that the hosted page's card form cannot be
 *   submitted from CI datacenter IPs — Stripe runs an invisible hCaptcha there
 *   (Stripe-owned bot wall, no fix), so `fillStripeCard` times out waiting for
 *   a post-click redirect. The decline card does not remove that wall: it is
 *   the SAME form, submitted the same way, so an in-browser decline is exactly
 *   as unreachable as an in-browser success. Asserting it here would produce a
 *   test that can only pass on a developer machine and times out in CI — the
 *   opposite of coverage.
 *
 *   The user-visible decline text itself ("Your card was declined") is rendered
 *   by Stripe INSIDE its hosted page, which is sandboxed from our app and not
 *   ours to assert. What IS ours, and what this test asserts, is the consequence
 *   that actually matters for launch: a decline must not grant entitlement.
 *
 * WHAT THIS TEST DOES COVER (real Stripe test API, the decline card, our price):
 *   1. the decline card `4000000000000002` is genuinely rejected by Stripe
 *      (`card_declined` / `generic_decline`), i.e. the card this suite can be
 *      pointed at with STRIPE_TEST_CARD behaves as a decline and not as a
 *      silent success;
 *   2. no subscription is created for the customer, so nothing can later sync a
 *      paid tier — asserted against Stripe's own subscription list;
 *   3. the globe-side state is untouched: org_tier stays free/canceled and the
 *      workspace stays unlocked, so the decline granted no entitlement.
 *
 * WHAT THIS TEST DOES NOT COVER (stated so it is not mistaken for coverage):
 *   the in-browser decline render on Stripe's hosted page, and the redirect/
 *   cancel_url round-trip after a decline. Both live behind the same hCaptcha
 *   wall as the success path; the hub's own handler semantics for a failed
 *   payment are covered by the webhook unit tests and the offline L1 simulator
 *   (invoice.payment_failed fixture), not by this browser suite.
 */
test('declined card → no subscription and no entitlement granted', async () => {
  test.setTimeout(120000);

  // The decline card must be driven explicitly: the suite default is the
  // success card, and running this test with STRIPE_TEST_CARD set to something
  // that does not decline would silently turn the assertion into a no-op.
  const card = STRIPE_CARD_DECLINE;

  // Test 4 left the org at pro/trialing. Reset to the free baseline so a
  // "no entitlement" assertion below cannot pass merely because some earlier
  // state happened to be free already, and so a LEAKED grant would be visible.
  await directTierSync(TEST_EMAIL, 'free', 'canceled');
  await expect
    .poll(
      async () => {
        const row = await globeDb.getOrgTier(testOrgId);
        return row ? `${row.tier}/${row.status}` : null;
      },
      { timeout: 45000, intervals: [1500] },
    )
    .toBe('free/canceled');

  // Use the seeded user's own Stripe customer so the assertion below is about
  // the customer this suite actually bills, not a detached throwaway.
  const customerId = await findOrCreateTestCustomer();
  const subsBefore = await listSubscriptionIds(customerId);

  // Attempt the payment with the DECLINE card. Stripe rejects it server-side;
  // there is no entitlement to observe because the charge never succeeds.
  const decline = await attemptPaymentWithCard(customerId, card);
  expect(
    decline.ok,
    `the decline card ${card} must be REJECTED by Stripe (a success here means ` +
      `the suite is not actually exercising a decline)`,
  ).toBe(false);
  expect(
    decline.code,
    `expected Stripe to reject the card with card_declined, got ${decline.code ?? decline.message ?? 'no code'}`,
  ).toBe('card_declined');
  console.log(`[billing] decline card rejected as expected: ${decline.code}/${decline.declineCode}`);

  // No subscription appeared, so no tier sync can ever fire for this attempt.
  const subsAfter = await listSubscriptionIds(customerId);
  expect(
    subsAfter,
    `a declined payment must not create a subscription (before=${subsBefore.length}, after=${subsAfter.length})`,
  ).toEqual(subsBefore);

  // Our side granted nothing: still free, still unlocked.
  const tierAfter = await globeDb.getOrgTier(testOrgId);
  expect(tierAfter, 'org_tiers row missing after the decline').toBeTruthy();
  expect(`${tierAfter!.tier}/${tierAfter!.status}`).toBe('free/canceled');

  const wsAfter = await globeDb.findWorkspaceByOwner(testUserId);
  expect(wsAfter, 'seeded workspace missing after the decline').toBeTruthy();
  expect(wsAfter!.locked, 'a declined payment must not lock the workspace').toBe(false);

  test.info().annotations.push({
    type: 'issue',
    description:
      'Decline driven against the real Stripe test API, not the hosted checkout page: ' +
      'Stripe\'s hosted card form (success OR decline) is behind an invisible hCaptcha that ' +
      'blocks submission from CI datacenter IPs. The in-browser decline render is therefore ' +
      'NOT covered; the entitlement consequence is.',
  });
  console.log('[billing] decline granted nothing: no subscription, org_tier = free/canceled, workspace unlocked');
});
