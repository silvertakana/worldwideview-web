/* eslint-disable no-console */
import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { GlobeDb } from './lib/globe-db';
import { loadHubEnv } from './lib/env';
import { cancelStaleSubscriptions } from './lib/stripe';
import {
  GLOBE_URL,
  directTierSync,
  provisionGlobeUser,
  signCrossServiceRequest,
} from './lib/globe-sync';
import { deleteSupabaseUserByEmail, ensureSupabaseUser, supabaseAdmin } from './lib/supabase-admin';

/**
 * E2E coverage for the REAL UI create-instance / provisioning flow
 * (branch fix/provisioning-ux). Fills the gap left by billing-flow.spec.ts
 * and billing-provision.spec.ts, which never drive:
 *   - the /accounts/instances page + CreateInstanceForm
 *   - POST /api/provisioning/instance -> globe /api/instance
 *   - the zero-instance CTA (commit 497b9f8)
 *   - the silent-skip banner (commit 44968a8)
 *   - client-side subdomain validation, duplicate-409, no-entitlement 403
 *
 * STACK (externally managed, same as the billing suite):
 *   - hub    https://hub.wwv.local   (wwv-dev-hub, this repo)
 *   - globe  http://localhost:3000    (wwv-dev-globe, globe repo)
 *   - globe DB postgresql://postgres:postgres@127.0.0.1:5432/worldwideview
 *   - Supabase = the hub's auth provider (LIVE project in the local dev
 *     stack — same one billing.global.setup.ts creates users in)
 *
 * ACCESS MECHANISM — the create-instance route is gated by the billing
 * authority, src/lib/billing/cloud-access.ts, which resolves access from
 * three stores in one order: billing_subscriptions (Stripe, or an operator's
 * manual grant), billing_overrides (an audited operator grant), then
 * user_entitlements (redeemed codes). With a grant from none of them it
 * returns 403 "No active plan. Choose a plan at /pricing to create your
 * workspace." and the instances page shows the plan CTA instead of the form.
 *
 * This suite seeds BOTH paths through the service-role PostgREST API (the
 * same surface createAdminClient() uses):
 *
 *   - { access: 'code' } -> a user_entitlements row, exactly mirroring what
 *     src/app/accounts/redeem/actions.ts writes for a redeemed code. This is
 *     the DRAIN path: the accounts already holding a redeemed code must keep
 *     working now that the code surfaces are hidden, so most of these tests
 *     deliberately still go through it. Its user_id FK is ON DELETE CASCADE
 *     (migration 20260703000001_create_access_codes.sql), so deleting the
 *     Supabase user in teardown removes the entitlement rows too.
 *
 *   - { access: 'paid' } -> a billing_subscriptions row, the path a real
 *     purchase takes. Test 7 is the regression test for the defect this
 *     branch fixes: a paying customer with ZERO entitlement rows was refused
 *     a workspace and shown a redeem-code button instead. Its user_id FK is
 *     ON DELETE SET NULL, so teardown deletes that row by email rather than
 *     trusting the cascade.
 *
 * TEST USERS — each test seeds its OWN fresh user so every test starts from
 * a known state (billing-provision pattern), and purges it in afterAll.
 * Stripe hygiene (cancelStaleSubscriptions) runs per-user so a recycled
 * shared-account customer can never render a free user as paid via
 * getHubTierFallback's email match.
 *
 * GLOBE instanceCount FIX (landed): the globe's /api/service/tier now
 * returns instanceCount (globe commit ccd1600a, branch fix/tier-instance-count
 * — count of workspaces owned by the org's owner). The billing page reads it
 * (src/app/accounts/billing/page.tsx: data.instanceCount ?? 0), so after a
 * successful create the zero-instance CTA (instanceCount === 0) disappears.
 * Test 2 asserts that fixed behavior.
 *
 * PLAN DISPLAY (hub authority, PR #69): the billing page treats a globe
 * "free" as inconclusive and consults the hub's authority (Stripe live
 * subscription first, then code-redeemed user_entitlements rows via
 * getHubTierFallback). This suite grants each user a pro entitlement row,
 * so the post-create billing page renders the PRO plan even though the
 * globe mirror (org_tiers, written only on tier-sync after payment) still
 * reports tier=free. The "Instances: X of Y used" line renders for the
 * non-local plan; the globe tier payload carries no instanceLimit, so the
 * page shows "Unlimited". The instance count is asserted via the CTA's
 * disappearance (the CTA renders only when instanceCount === 0) plus the
 * globe DB workspace row and the /accounts/instances UI list.
 *
 * NO RETRIES (tests/playwright.billing.config.ts sets retries: 0). Each test
 * seeds ONE user, ONE checkout and ONE subscription against shared state the
 * run mutates, so a retry would re-run the same assertions against state the
 * first attempt already changed - reporting a second, different failure
 * instead of the real one. A flake here is a signal to fix the assertion.
 */

export const PASSWORD = 'Provisioning-2026!!';

const USERS = {
  cta: 'billing-create-cta@worldwideview.local',
  happy: 'billing-create-happy@worldwideview.local',
  invalid: 'billing-create-invalid@worldwideview.local',
  dup: 'billing-create-dup@worldwideview.local',
  noent: 'billing-create-noent@worldwideview.local',
  banner: 'billing-create-banner@worldwideview.local',
  paid: 'billing-create-paid@worldwideview.local',
};

// ---------------------------------------------------------------------------
// Env loading (worker processes do NOT inherit env set in globalSetup).
// ---------------------------------------------------------------------------
loadHubEnv();

const WORKSPACE_DOMAIN = process.env.NEXT_PUBLIC_WORKSPACE_DOMAIN || 'wwv.local';

/**
 * Grant a pro entitlement by inserting a user_entitlements row through the
 * service-role PostgREST API — the same table + bypass the app's
 * createAdminClient() uses. Without this row the create-instance route
 * returns 403 and the instances page shows the redeem block.
 */
async function grantProEntitlement(userId: string): Promise<void> {
  const res = await supabaseAdmin('/rest/v1/user_entitlements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ user_id: userId, tier: 'pro', source: 'e2e_test', grants_days: 30 }),
  });
  const body = await res.json();
  expect(
    res.ok,
    `entitlement insert failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`,
  ).toBeTruthy();
  console.log(`[provisioning-create] Pro entitlement granted to user ${userId.slice(0, 8)}`);
}

/** Best-effort removal of any entitlement rows (belt: user delete cascades). */
async function revokeEntitlements(userId: string): Promise<void> {
  try {
    await supabaseAdmin(`/rest/v1/user_entitlements?user_id=eq.${userId}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });
  } catch {
    // Ignore — the Supabase user delete cascades anyway.
  }
}

/**
 * Grant PAID access by inserting a billing_subscriptions row — the durable
 * record a real Stripe webhook writes. Deliberately inserts NO
 * user_entitlements row: that absence is what the old gate keyed on, and it is
 * the exact production state of the one live paying customer.
 */
async function grantPaidSubscription(userId: string, email: string): Promise<void> {
  const res = await supabaseAdmin('/rest/v1/billing_subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: userId,
      email,
      plan: 'pro',
      status: 'active',
      stripe_status: 'active',
      stripe_subscription_id: `sub_e2e_${randomUUID()}`,
      source: 'stripe',
    }),
  });
  const body = await res.json();
  expect(
    res.ok,
    `subscription insert failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`,
  ).toBeTruthy();
  console.log(`[provisioning-create] Paid subscription granted to user ${userId.slice(0, 8)}`);
}

/**
 * Best-effort removal of the durable subscription row. Deliberately by email
 * and NOT left to the user delete: billing_subscriptions.user_id is ON DELETE
 * SET NULL, so the row would survive with the email that still matches it —
 * and UNIQUE(email) would then reject the next run's seed.
 */
async function revokeSubscription(email: string): Promise<void> {
  try {
    await supabaseAdmin(`/rest/v1/billing_subscriptions?email=eq.${encodeURIComponent(email)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });
  } catch {
    // Ignore — the row is inert once the test user is gone.
  }
}

// ---------------------------------------------------------------------------
// Globe DB access: GlobeDb for user/purge, raw pg for workspace rows by
// subdomain (GlobeDb exposes no workspace-by-subdomain query, and tests/lib/*
// is off-limits — this spec brings its own minimal Pool instead).
// ---------------------------------------------------------------------------
interface WorkspaceRow {
  id: string;
  subdomain: string;
  ownerId: string;
  status: string;
  plan: string;
  tier: string;
}

let globeDb: GlobeDb;
let pgPool: Pool;

async function findWorkspaceBySubdomain(subdomain: string): Promise<WorkspaceRow | null> {
  const res = await pgPool.query<WorkspaceRow>(
    'SELECT id, subdomain, "ownerId", status, plan, tier FROM "workspaces" WHERE subdomain = $1 LIMIT 1',
    [subdomain],
  );
  return res.rows[0] ?? null;
}

async function countWorkspacesByOwner(ownerId: string): Promise<number> {
  const res = await pgPool.query<{ id: string }>('SELECT id FROM "workspaces" WHERE "ownerId" = $1', [ownerId]);
  return res.rows.length;
}

// ---------------------------------------------------------------------------
// User lifecycle registry (per-test users, purged in afterAll).
// ---------------------------------------------------------------------------
interface TestUser {
  email: string;
  supabaseId: string | null;
  entitled: boolean;
}

const registered: TestUser[] = [];

/** 'paid' = a durable subscription row; 'code' = a redeemed-code entitlement;
 *  omitted = no grant at all, which is the only state the route refuses. */
type SeedAccess = 'paid' | 'code';

async function setupUser(email: string, opts: { access?: SeedAccess } = {}): Promise<TestUser> {
  // Fresh state on every side: no globe rows, no hub auth user, no live subs,
  // no leftover durable subscription (UNIQUE(email) would reject the seed).
  await globeDb.purgeTestUser(email);
  await deleteSupabaseUserByEmail(email);
  await revokeSubscription(email);
  await cancelStaleSubscriptions(email);
  const supabaseId = await ensureSupabaseUser(email, PASSWORD, 'Provisioning E2E Tester');
  const user: TestUser = { email, supabaseId, entitled: opts.access === 'code' };
  registered.push(user);
  if (opts.access === 'code') await grantProEntitlement(supabaseId);
  if (opts.access === 'paid') await grantPaidSubscription(supabaseId, email);
  return user;
}

/** Login as a NON-storage-state user (mirrors billing-provision + the
 *  hydration guard from billing.global.setup.ts: clicking submit before
 *  React hydrates triggers a native GET reload with credentials in the URL). */
async function loginAs(page: Page, email: string, password: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/login', { timeout: 90000 });
  await page.waitForFunction(
    () => {
      const form = document.querySelector('form');
      return !!form && Object.keys(form).some((key) => key.startsWith('__reactProps$'));
    },
    undefined,
    { timeout: 60000 },
  );
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);

  const submitAndWait = async (): Promise<boolean> => {
    await page.click('button[type="submit"]');
    try {
      await page.waitForURL(
        (url) =>
          url.pathname.startsWith('/pricing') ||
          url.pathname.startsWith('/accounts') ||
          url.pathname.startsWith('/hub'),
        { timeout: 25000 },
      );
      return true;
    } catch {
      return false;
    }
  };

  let loggedIn = await submitAndWait();
  if (!loggedIn) {
    console.log(`[provisioning-create] First login click did not navigate; retrying once`);
    await page.waitForLoadState('domcontentloaded');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    loggedIn = await submitAndWait();
  }
  if (!loggedIn) {
    throw new Error(`[provisioning-create] UI login failed for ${email}. Final URL: ${page.url()}`);
  }
  await page.waitForTimeout(500); // let the session cookie settle
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe.configure({ mode: 'serial', timeout: 240000 });

test.beforeAll(async () => {
  globeDb = new GlobeDb();
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/worldwideview?schema=public',
  });
  await globeDb.ping();
});

test.afterAll(async () => {
  try {
    for (const u of registered) {
      if (u.supabaseId) await revokeEntitlements(u.supabaseId);
      await revokeSubscription(u.email);
      await deleteSupabaseUserByEmail(u.email);
      await cancelStaleSubscriptions(u.email);
      await globeDb.purgeTestUser(u.email);
    }
    console.log(`[provisioning-create] Purged ${registered.length} test users`);
  } finally {
    await globeDb.close();
    await pgPool.end();
  }
});

// ---------------------------------------------------------------------------
// Test 1 — zero-instance CTA
// ---------------------------------------------------------------------------
test('provisioning-create CTA: zero-instance billing page links to /accounts/instances', async ({ page }) => {
  const u = await setupUser(USERS.cta);
  await loginAs(page, u.email, PASSWORD);
  await page.goto('/accounts/billing');

  const cta = page.getByRole('link', { name: /create your first instance/i });
  await expect(cta).toBeVisible({ timeout: 30000 });
  expect(await cta.getAttribute('href'), 'CTA must point at the instances page').toBe('/accounts/instances');
  console.log('[provisioning-create] Zero-instance CTA visible, href=/accounts/instances');
});

// ---------------------------------------------------------------------------
// Test 2 — real UI create-instance happy path
// ---------------------------------------------------------------------------
test('provisioning-create happy path: entitled user creates a workspace via the UI; it lands in the list + globe DB', async ({ page }) => {
  const u = await setupUser(USERS.happy, { access: 'code' });
  const subdomain = `ui-e2e-${Date.now().toString(36)}`;

  await loginAs(page, u.email, PASSWORD);
  await page.goto('/accounts/instances');

  const createBtn = page.getByRole('button', { name: /create new instance/i });
  await expect(createBtn).toBeVisible({ timeout: 30000 });
  await createBtn.click();

  await page.getByPlaceholder('my-workspace').fill(subdomain);
  await page.getByPlaceholder('My Workspace').fill('UI E2E Workspace');

  const postRespP = page.waitForResponse(
    (r) => r.url().includes('/api/provisioning/instance') && r.request().method() === 'POST',
    { timeout: 30000 },
  );
  await page.getByRole('button', { name: /create instance/i }).click();
  const resp = await postRespP;
  expect(
    resp.status(),
    `create-instance POST returned ${resp.status()}: ${(await resp.text()).slice(0, 200)}`,
  ).toBe(200);
  console.log('[provisioning-create] create-instance POST 200');

  // The workspace appears in the UI list (onCreated -> fetchWorkspaces).
  await expect(page.getByText(`${subdomain}.${WORKSPACE_DOMAIN}`, { exact: false })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByText('UI E2E Workspace', { exact: false }).first()).toBeVisible({ timeout: 10000 });
  console.log('[provisioning-create] Workspace visible in the instances UI list');

  // Globe DB row: status active, plan basic, tier pro (from the pro entitlement).
  await expect
    .poll(
      async () => {
        const ws = await findWorkspaceBySubdomain(subdomain);
        return ws ? `${ws.status}/${ws.plan}/${ws.tier}` : null;
      },
      { timeout: 30000, intervals: [1000] },
    )
    .toBe('active/basic/pro');

  const ws = await findWorkspaceBySubdomain(subdomain);
  expect(ws, 'workspace row must exist in the globe DB').toBeTruthy();
  const globeUser = await globeDb.findUserByEmail(u.email);
  expect(globeUser, 'hub route provisions the globe user before /api/instance').toBeTruthy();
  expect(ws!.ownerId, 'workspace must be owned by the provisioned globe user').toBe(globeUser!.id);
  console.log('[provisioning-create] Globe DB row: workspaces(active/basic/pro), owner = provisioned user');

  // Billing page post-create state (globe instanceCount fix landed — see
  // header). The globe /api/service/tier now returns instanceCount: 1 for
  // this user's org, so:
  //   1. The zero-instance CTA (instanceCount === 0) DISAPPEARS — the fixed
  //      behavior this test asserts. The CTA is the billing page's only
  //      instanceCount-driven element, so its disappearance proves the
  //      count flowed from the globe through the hub to the UI.
  //   2. Hub-authority plan display (PR #69): a UI create-instance alone
  //      never writes org_tiers, so the globe mirror reports tier=free and
  //      that is INCONCLUSIVE. The page consults the hub's authority
  //      (getHubTierFallback) and resolves this user's e2e-granted pro
  //      entitlement (user_entitlements row) to the Pro plan. The
  //      "Instances: X of Y used" line (gated on {!isLocal}) now
  //      RENDERS (instanceCount 1; the globe tier payload carries no
  //      instanceLimit, so the page shows "Unlimited").
  await page.goto('/accounts/billing');
  await expect(page.getByText(/You are on the Pro plan\./)).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('link', { name: /create your first instance/i })).toHaveCount(0, {
    timeout: 10000,
  });
  await expect(page.getByText(/Instances: \d+ of (Unlimited|\d+) used/)).toBeVisible({ timeout: 10000 });
  console.log('[provisioning-create] Billing page: Pro plan shown (hub authority), zero-instance CTA gone, instances line visible (instanceCount=1)');
});

// ---------------------------------------------------------------------------
// Test 3 — invalid subdomain client validation
// ---------------------------------------------------------------------------
test('provisioning-create invalid subdomain: client validation blocks submit, no globe call', async ({ page }) => {
  const u = await setupUser(USERS.invalid, { access: 'code' });
  await loginAs(page, u.email, PASSWORD);
  await page.goto('/accounts/instances');

  const createBtn = page.getByRole('button', { name: /create new instance/i });
  await expect(createBtn).toBeVisible({ timeout: 30000 });
  await createBtn.click();

  const subdomainInput = page.getByPlaceholder('my-workspace');
  const provisionPosts: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/provisioning/instance') && req.method() === 'POST') {
      provisionPosts.push(req.url());
    }
  });

  // Too short (< 3 chars) — CreateInstanceForm validate().
  await subdomainInput.fill('ab');
  await expect(page.getByText('Subdomain must be at least 3 characters')).toBeVisible();
  // Reserved subdomain.
  await subdomainInput.fill('www');
  await expect(page.getByText('"www" is a reserved subdomain')).toBeVisible();
  // Bad characters.
  await subdomainInput.fill('Bad_Name!');
  await expect(page.getByText('Invalid subdomain - letters, numbers, and hyphens only')).toBeVisible();

  // handleSubmit early-returns while validationError is set — the button
  // must surface "Fix validation errors first" instead of POSTing.
  await page.getByRole('button', { name: /create instance/i }).click();
  await expect(page.getByText('Fix validation errors first')).toBeVisible();

  // No POST ever reached the route (poll passes immediately on 0).
  await expect.poll(() => provisionPosts.length, { timeout: 3000 }).toBe(0);
  console.log('[provisioning-create] Client validation shown; no create-instance POST fired');
});

// ---------------------------------------------------------------------------
// Test 4 — duplicate subdomain 409
// ---------------------------------------------------------------------------
test('provisioning-create duplicate subdomain: form shows "Subdomain already taken"', async ({ page }) => {
  const u = await setupUser(USERS.dup, { access: 'code' });
  const subdomain = `dup-e2e-${Date.now().toString(36)}`;

  // Pre-take the subdomain on the globe (the "create once" step) via a direct
  // HMAC-signed POST to /api/instance with a throwaway user. The REAL UI path
  // for a 409 is exercised by typing the taken subdomain into the form: after
  // a SUCCESSFUL create the route marks entitlement used and the UI disables
  // the form, so the only reachable duplicate-409 surface is a fresh entitled
  // user typing an already-taken subdomain (markEntitlementUsed only runs on
  // res.ok — a 409 leaves the form open with the error in the errorBox).
  const seedEmail = `dup-seed-${Date.now().toString(36)}@worldwideview.local`;
  registered.push({ email: seedEmail, supabaseId: null, entitled: false });
  const seedBody = { subdomain, name: 'Duplicate Seed', userId: randomUUID(), email: seedEmail, tier: 'pro' };
  const seedRes = await fetch(`${GLOBE_URL}/api/instance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Signature': signCrossServiceRequest('POST', '/api/instance', seedBody) },
    body: JSON.stringify(seedBody),
  });
  const seedData = await seedRes.json().catch(() => null);
  expect(seedRes.status, `globe seed create failed (${seedRes.status}): ${JSON.stringify(seedData).slice(0, 150)}`).toBe(200);
  console.log(`[provisioning-create] Subdomain ${subdomain} pre-taken on the globe`);

  await loginAs(page, u.email, PASSWORD);
  await page.goto('/accounts/instances');
  const createBtn = page.getByRole('button', { name: /create new instance/i });
  await expect(createBtn).toBeVisible({ timeout: 30000 });
  await createBtn.click();

  await page.getByPlaceholder('my-workspace').fill(subdomain);
  await page.getByRole('button', { name: /create instance/i }).click();

  // The globe 409 is proxied through the hub route into the form errorBox.
  await expect(page.getByText('Subdomain already taken')).toBeVisible({ timeout: 30000 });
  // Entitlement is NOT marked used on failure, so the form stays open.
  await expect(page.getByRole('button', { name: /create instance/i })).toBeVisible();
  console.log('[provisioning-create] Duplicate subdomain surfaced "Subdomain already taken" in the form');

  // The UI user must NOT own the pre-taken workspace (the 409 happens before
  // workspace creation; the route's best-effort provision may create the globe
  // user but never a workspace for this subdomain under this owner).
  const globeUser = await globeDb.findUserByEmail(u.email);
  if (globeUser) {
    expect(await countWorkspacesByOwner(globeUser.id), '409 must not create a workspace for the user').toBe(0);
  }
});

// ---------------------------------------------------------------------------
// Test 5 — no access of any kind
// ---------------------------------------------------------------------------
test('provisioning-create no access: instances page shows the plan CTA, POST is 403', async ({ page }) => {
  const u = await setupUser(USERS.noent); // deliberately NO grant of any kind
  await loginAs(page, u.email, PASSWORD);
  await page.goto('/accounts/instances');

  // The UI renders the blocked state instead of the create button. Scoped to
  // the inner content main, where the CTA lives.
  const content = page.locator('main main');
  await expect(page.getByText(/Choose a plan to create your workspace/)).toBeVisible({ timeout: 30000 });
  await expect(content.getByRole('link', { name: /view plans/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /create new instance/i })).toHaveCount(0);

  // No code affordance survives anywhere on the page — not in the sidebar, not
  // in the header, not in the blocked state. This is the "hidden, not deleted"
  // guarantee the customer-facing change is for.
  await expect(page.getByRole('link', { name: /redeem/i })).toHaveCount(0);

  // The route itself rejects with the authority's refusal message.
  const res = await page.request.post('/api/provisioning/instance', {
    data: { subdomain: `noent-${Date.now().toString(36)}`, name: 'No Access' },
  });
  expect(res.status(), `no-access POST should 403, got ${res.status()}`).toBe(403);
  const body = await res.json();
  expect(body.error).toContain('No active plan');
  console.log('[provisioning-create] Plan CTA shown; direct POST rejected 403 "No active plan"');
});

// ---------------------------------------------------------------------------
// Test 6 — silent-skip banner
// ---------------------------------------------------------------------------
test('provisioning-create silent-skip banner: shows for paid-but-unprovisioned, clears after provision succeeds', async ({ page }) => {
  const u = await setupUser(USERS.banner, { access: 'code' });

  await loginAs(page, u.email, PASSWORD);
  await page.goto('/accounts/billing');

  // The globe has NO org for this user -> tier GET 404s -> the billing page
  // falls back to hub data (pro entitlement) and renders the silent-skip
  // banner (billing/page.tsx: !globeSucceeded && paid && zero instances).
  await expect(page.getByText(/couldn.?t be fully set up/i)).toBeVisible({ timeout: 45000 });
  // Prove the page is in the PAID state (so the banner is not a free-user
  // artifact): the pro entitlement fallback renders the Pro badge.
  await expect(page.getByText('Pro', { exact: true }).first()).toBeVisible({ timeout: 10000 });
  console.log('[provisioning-create] Silent-skip banner visible for paid + unprovisioned user (Pro badge shown)');

  // Make provisioning succeed through the verified endpoints — the SAME
  // calls the webhook makes (provision, then tier-sync). Order matters:
  // tier-sync 404s when the email has no globe org.
  await provisionGlobeUser(u.email, u.supabaseId!, 'Banner E2E User');
  await directTierSync(u.email, 'pro', 'trialing');

  // Fresh SSR render — the globe tier now succeeds, so the banner disappears.
  await page.goto('/accounts/billing');
  await expect(page.getByText(/couldn.?t be fully set up/i)).toHaveCount(0, { timeout: 45000 });
  // Assert the trial state through the sentence rather than the "Pro - Trial"
  // badge: the badge's text is not unique in the DOM (the page transiently
  // resolves it to more than one element while it fills in, which fails strict
  // mode), while the sentence below is rendered only in the trialling state
  // (src/app/accounts/billing/page.tsx). `.first()` is the guard the sibling
  // assertion above already uses.
  await expect(page.getByText(/You are on the Pro plan \(trial\)\./).first()).toBeVisible({ timeout: 30000 });
  console.log('[provisioning-create] Banner cleared after provisioning + tier-sync (trial state sentence shown)');
});

// ---------------------------------------------------------------------------
// Test 7 — the paid path, with no code involved
// ---------------------------------------------------------------------------
test('provisioning-create paid path: a subscription with zero entitlements creates a workspace', async ({ page }) => {
  // THE regression test for the defect this branch fixes. This is the exact
  // production state that used to be refused: a durable billing_subscriptions
  // row (plan pro, status active) and NO user_entitlements row.
  const u = await setupUser(USERS.paid, { access: 'paid' });
  const subdomain = `paid-e2e-${Date.now().toString(36)}`;

  await loginAs(page, u.email, PASSWORD);
  await page.goto('/accounts/instances');

  // The instances page reads the billing authority, so this account is neither
  // blocked nor offered a code.
  await expect(page.getByRole('button', { name: /create new instance/i })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('link', { name: /redeem/i })).toHaveCount(0);
  await expect(page.getByText(/Choose a plan to create your workspace/)).toHaveCount(0);

  await page.getByRole('button', { name: /create new instance/i }).click();
  await page.getByPlaceholder('my-workspace').fill(subdomain);
  await page.getByPlaceholder('My Workspace').fill('Paid E2E Workspace');

  const postRespP = page.waitForResponse(
    (r) => r.url().includes('/api/provisioning/instance') && r.request().method() === 'POST',
    { timeout: 30000 },
  );
  await page.getByRole('button', { name: /create instance/i }).click();
  const resp = await postRespP;
  expect(
    resp.status(),
    `paid create-instance POST returned ${resp.status()}: ${(await resp.text()).slice(0, 200)}`,
  ).toBe(200);
  console.log('[provisioning-create] Paid, entitlement-free user: create-instance POST 200');

  // The workspace lands with a GLOBE tier (pro), not a hub-only tier the globe
  // would have rejected with a 400.
  await expect
    .poll(
      async () => {
        const ws = await findWorkspaceBySubdomain(subdomain);
        return ws ? `${ws.status}/${ws.plan}/${ws.tier}` : null;
      },
      { timeout: 30000, intervals: [1000] },
    )
    .toBe('active/basic/pro');
  console.log('[provisioning-create] Globe DB row active/basic/pro for the paid, entitlement-free user');
});
