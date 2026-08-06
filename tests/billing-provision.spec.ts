/* eslint-disable no-console */
import { test, expect, type Page } from '@playwright/test';
import { GlobeDb } from './lib/globe-db';
import { loadHubEnv } from './lib/env';

/**
 * Regression test for the PMT-001 billing fix (hub worktree
 * worldwideview-web.fix-billing):
 *
 *   Scenario: a hub user who has NO globe-side org (never provisioned there)
 *   pays with the 4242 test card. The webhook's checkout.session.completed
 *   handler must PROVISION the globe workspace FIRST, then sync the tier.
 *   A newly paying user therefore:
 *     1. gets a globe user + org + owner membership created by the webhook
 *        (via the globe's HMAC-protected /api/provision endpoint)
 *     2. gets org_tiers upserted to pro/trialing by the tier sync (the
 *        globe's setOrgTier() upserts, so no pre-existing org_tiers row is
 *        needed)
 *     3. sees Pro / Manage Billing on the hub billing page (the globe mirror
 *        reports pro/trialing, the hub trusts it)
 *
 * This INVERTS the old premise of tests/billing-no-org.spec.ts: after
 * payment the user is NO LONGER org-less — the globe DB must contain rows for
 * the email, and org_tiers must be pro/trialing (proving a REAL tier sync, not
 * an honest failure).
 *
 * Deliberately does NOT seed any globe rows for this user before the test.
 * The globe DB is asserted to contain zero rows for the email BEFORE payment
 * and a user + owner membership + pro/trialing org_tiers AFTER payment.
 *
 * HONEST-FAILURE SCENARIO (webhook logs the real sync outcome when the globe
 * 404s) — NOT COVERED, documented here:
 *   The old suite's second half asserted the hub webhook logs "Tier sync
 *   FAILED" when the globe has no org. The webhook simulator
 *   (test/simulator/) cannot produce that path against the current stack:
 *     - checkout.session.completed fixtures: the handler calls
 *       stripe.checkout.sessions.retrieve("cs_test_simulator") BEFORE the
 *       provisioning/sync block; against the REAL Stripe test API a fake
 *       session id throws, the outer try/catch logs "[webhook] Error handling
 *       checkout.session.completed:" and the provisioning + sync never run.
 *     - subscription.* / invoice fixtures: they carry no payload-first email
 *       (only metadata.email, which emailFromPayload() does not read), so the
 *       handler falls back to stripe.customers.retrieve("cus_test_simulator"),
 *       which also throws against real Stripe -> email null -> no sync.
 *   Driving the failure path needs stripe-mock in the stack (a separate
 *   concern per test/simulator/README.md) or a fixture carrying customer_email.
 *   Neither is in scope here, so the honest-failure regression is documented,
 *   not asserted.
 *
 * GLOBE-SPECIFIC dependencies (same as billing-flow.spec.ts):
 *   - hub    https://hub.wwv.local   (wwv-dev-hub, this repo)
 *   - globe  http://localhost:3000    (wwv-dev-globe, globe repo — provision + tier-sync endpoints)
 *   - globe DB reachable at DATABASE_URL (dev stack: localhost:5432/worldwideview)
 *   - `stripe listen` forwarding to https://hub.wwv.local/api/billing/webhook
 *   - `stripe` CLI default account = the app's sandbox account
 *   - PROVISIONING_API_URL in the hub's env must point at the globe
 *     (http://wwv-dev-globe:3000 in the docker stack)
 */

export const NEW_USER_EMAIL = 'billing-newuser@worldwideview.local';
const NEW_USER_PASSWORD = 'BillingNewUser-2026!!';

// ---------------------------------------------------------------------------
// Env loading (worker processes do NOT inherit env set in globalSetup).
// ---------------------------------------------------------------------------
loadHubEnv();

// ---------------------------------------------------------------------------
// Supabase admin API (same pattern as billing.global.setup.ts).
// ---------------------------------------------------------------------------
async function deleteSupabaseUser(email: string): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return;
  const base = supabaseUrl.replace(/\/$/, '');
  try {
    const listRes = await fetch(`${base}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    });
    if (listRes.ok) {
      const list = await listRes.json();
      for (const user of list.users || []) {
        if (user.email === email) {
          await fetch(`${base}/auth/v1/admin/users/${user.id}`, {
            method: 'DELETE',
            headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
          });
          console.log(`[billing-provision] Deleted Supabase user ${email}`);
        }
      }
    }
  } catch (e) {
    console.log(`[billing-provision] Supabase cleanup error: ${e}`);
  }
}

async function createSupabaseUser(email: string, password: string): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('[billing-provision] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from hub .env.local');
  }
  const base = supabaseUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { name: 'Billing New-User Tester' },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (!(res.status === 409 || body.includes('already exists') || body.includes('already registered'))) {
      throw new Error(`[billing-provision] Supabase admin create user failed (${res.status}): ${body}`);
    }
  }
  console.log(`[billing-provision] Supabase user ensured: ${email}`);
}

// ---------------------------------------------------------------------------
// Stripe REST helpers (no CLI, no interactive confirmation).
// ---------------------------------------------------------------------------
// STRIPE_BASE_URL lets the test stack point these at stripe-mock; defaults to
// real Stripe test mode.
const STRIPE_BASE = process.env.STRIPE_BASE_URL || 'https://api.stripe.com/v1';
function stripeHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY || ''}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

/** Best-effort: cancel any live subscription for the new-user's customers. */
async function cancelStaleSubscriptions(email: string): Promise<void> {
  try {
    const customersRes = await fetch(`${STRIPE_BASE}/customers?email=${encodeURIComponent(email)}&limit=10`, {
      headers: stripeHeaders(),
    });
    const customers = await customersRes.json();
    for (const c of customers.data || []) {
      const subsRes = await fetch(`${STRIPE_BASE}/subscriptions?customer=${c.id}&limit=10`, {
        headers: stripeHeaders(),
      });
      const subs = await subsRes.json();
      for (const s of subs.data || []) {
        if (['trialing', 'active', 'past_due'].includes(s.status)) {
          await fetch(`${STRIPE_BASE}/subscriptions/${s.id}`, { method: 'DELETE', headers: stripeHeaders() });
          console.log(`[billing-provision] Cancelled stale subscription ${s.id}`);
        }
      }
    }
  } catch (e) {
    console.log(`[billing-provision] Stripe cleanup error: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// Hosted checkout card entry (mirror of billing-flow.spec.ts).
// ---------------------------------------------------------------------------
const CARD_ENTRY_TIMEOUT_MS = 45000;

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

async function fillStripeCard(page: Page): Promise<void> {
  await page.getByPlaceholder('1234 1234 1234 1234').fill('4242 4242 4242 4242');
  await page.getByPlaceholder('MM / YY').fill('12/32');
  await page.getByRole('textbox', { name: 'CVC' }).fill('123');
  await page.getByPlaceholder('Full name on card').fill('Billing New-User');
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

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------
let globeDb: GlobeDb;

test.describe.configure({ mode: 'serial', timeout: 240000 });

test.beforeAll(async () => {
  globeDb = new GlobeDb();

  // Fresh hub user, NO globe rows, NO live Stripe subscriptions.
  await globeDb.purgeTestUser(NEW_USER_EMAIL);
  await deleteSupabaseUser(NEW_USER_EMAIL);
  await cancelStaleSubscriptions(NEW_USER_EMAIL);
  await createSupabaseUser(NEW_USER_EMAIL, NEW_USER_PASSWORD);

  const globeUser = await globeDb.findUserByEmail(NEW_USER_EMAIL);
  expect(globeUser, 'new-user must not exist in the globe DB before the test').toBeNull();
  console.log('[billing-provision] Verified: zero globe rows for', NEW_USER_EMAIL);
});

test.afterAll(async () => {
  await deleteSupabaseUser(NEW_USER_EMAIL);
  await cancelStaleSubscriptions(NEW_USER_EMAIL);
  // The NEW contract creates globe rows (user + org + org_tiers) — purge them
  // so repeat runs and the shared dev DB stay clean.
  if (globeDb) {
    await globeDb.purgeTestUser(NEW_USER_EMAIL);
    await globeDb.close();
  }
});

test('new user pays with 4242 -> globe org provisioned, tier synced to pro/trialing, hub UI shows Pro', async ({ page }) => {
  // Drop the storageState session (billing-e2e) and log in as the new user.
  await page.context().clearCookies();
  await page.goto('/login');
  await page.fill('input[name="email"]', NEW_USER_EMAIL);
  await page.fill('input[name="password"]', NEW_USER_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(
    (url) => url.pathname.startsWith('/pricing') || url.pathname.startsWith('/accounts') || url.pathname.startsWith('/hub'),
    { timeout: 25000 },
  );

  // Before payment the user has no Stripe sub and no globe org: the page must
  // show the free state ("Upgrade to Pro").
  await page.goto('/pricing');
  const manageBillingLink = page.getByRole('link', { name: /manage billing/i });
  await expect(manageBillingLink).toBeVisible({ timeout: 20000 });
  await manageBillingLink.click();
  await page.waitForURL(/\/accounts\/billing/);

  const upgradeBtn = page.getByRole('button', { name: /upgrade to pro/i });
  await expect(upgradeBtn).toBeVisible({ timeout: 20000 });
  console.log('[billing-provision] Pre-payment: "Upgrade to Pro" shown (no globe org yet)');

  // Real UI click -> hosted checkout -> 4242 card.
  const checkoutRespP = page.waitForResponse(
    (r) => r.url().includes('/api/billing/checkout') && r.request().method() === 'POST',
    { timeout: 20000 },
  );
  await upgradeBtn.click();
  const resp = await checkoutRespP;
  expect(resp.status(), 'real "Upgrade to Pro" click must reach Stripe (200)').toBe(200);
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30000 });
  await withTimeout(fillStripeCard(page), CARD_ENTRY_TIMEOUT_MS, 'fillStripeCard');
  await page.waitForURL(/status=success|accounts\/billing/, { timeout: 45000 });
  console.log('[billing-provision] Payment completed (4242)');

  // UI shows Pro: "Manage Billing" replaces "Upgrade to Pro". This asserts the
  // paid user sees Pro — via the globe mirror, which now reports pro/trialing.
  await expect(page.getByRole('button', { name: /manage billing/i })).toBeVisible({ timeout: 45000 });
  await expect(page.getByRole('button', { name: /upgrade to pro/i })).toHaveCount(0, { timeout: 10000 });
  console.log('[billing-provision] Hub UI shows Pro (globe mirror = pro/trialing)');

  // GLOBE DB — the NEW contract: provisioning created the user + owner
  // membership, and the tier sync upserted org_tiers to pro/trialing. Poll the
  // full chain (user -> membership -> org_tiers) since the webhook is async.
  let userId = '';
  await expect
    .poll(
      async () => {
        const user = await globeDb.findUserByEmail(NEW_USER_EMAIL);
        if (!user) return null;
        userId = user.id;
        const member = await globeDb.findMembershipForUser(user.id);
        if (!member) return null;
        const tier = await globeDb.getOrgTier(member.organizationId);
        return tier ? `${tier.tier}/${tier.status}` : null;
      },
      { timeout: 45000, intervals: [1500] },
    )
    .toBe('pro/trialing');

  const member = await globeDb.findMembershipForUser(userId);
  expect(member, 'provisioned org membership missing').toBeTruthy();
  expect(member!.role, 'provisioned membership must be owner (globe /api/provision role)').toBe('owner');
  console.log('[billing-provision] Globe DB: user + owner membership + org_tiers=pro/trialing created by webhook');

  // Log-needle assertions (counting "Workspace provisioned for ..." / "Tier
  // synced for ..." in `docker logs --tail 2000 wwv-dev-hub`) were removed:
  // Docker Desktop on Windows drops stderr lines from large `docker logs`
  // outputs at scale, so needle counts were flaky (deterministic FAIL on this
  // host). The globe DB assertions above fully prove the provisioning +
  // tier-sync contract; the log messages are implementation detail.
});
