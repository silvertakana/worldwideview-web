/* eslint-disable no-console */
import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GlobeDb } from './lib/globe-db';
import { loadHubEnv } from './lib/env';
import { cancelStaleSubscriptions } from './lib/stripe';

/**
 * E2E coverage for the REAL provisioning setup-link journey (the gap left by
 * billing-provisioning-create.spec.ts, which stops at "workspace row in globe
 * DB + UI list" and never navigates the setup link):
 *
 *   hub create-instance (UI form) -> workspace row -> Setup button
 *   -> GET /api/provisioning/workspace/{id}/setup-token
 *   -> globe /api/provision (fresh SetupToken)
 *   -> window.location = https://{subdomain}.wwv.local/setup?token=<raw>
 *   -> "Validating setup link..." -> "Activate Your Account" form
 *   -> activateProvisionedAccount (consumeSetupToken + emailVerified + password)
 *   -> /login -> sign in with the just-set password
 *   -> globe app root renders [data-testid="app-ready"]
 *
 * LAYERED VERIFICATION (flow-e2e-uat Stage 3): the UI journey is asserted at
 * three layers - UI state (setup button, activation form, post-login globe),
 * HTTP contract (create-instance POST 200, setup-token GET 200 + token in URL),
 * and globe DB rows (user.emailVerified=true, setup_tokens.usedAt consumed,
 * workspaces row active + owned by the provisioned user).
 *
 * TEST USERS - each test seeds its OWN fresh user (billing-provision pattern)
 * and purges it in afterAll. The workspace subdomain is DETERMINISTIC so the
 * only hosts/DNS change is a one-time entry; the spec deletes any stale
 * workspace row for that subdomain at setup, so repeat runs always start clean
 * (even if a prior run left a workspace owned by a different user).
 *
 * STACK (externally managed, same as the billing suite):
 *   - hub    https://hub.wwv.local   (wwv-dev-hub, this repo)
 *   - globe  https://{subdomain}.wwv.local / http://localhost:3000 (wwv-dev-globe)
 *   - globe DB postgresql://postgres:postgres@127.0.0.1:5432/worldwideview
 *   - Supabase = the hub's auth provider (LIVE local project)
 *
 * SUBDOMAIN: E2E_SUBDOMAIN env override, default 'asdf' (already in the local
 * hosts file). The globe must be reachable at https://{subdomain}.wwv.local
 * (Caddy *.wwv.local -> globe:3000; hosts entry 127.0.0.1 {subdomain}.wwv.local).
 *
 * Note: the invalid-token test intentionally runs on the ROOT domain
 * (https://wwv.local/setup) so it needs no workspace row and no auth - the
 * globe proxy keeps /setup public and the setup page validates the token
 * itself.
 */

export const PASSWORD = 'Provisioning-2026!!';

const SUBDOMAIN = process.env.E2E_SUBDOMAIN || 'asdf';

const USERS = {
  happy: 'billing-setuplink-happy@worldwideview.local',
};

// ---------------------------------------------------------------------------
// Env loading (worker processes do NOT inherit env set in globalSetup).
// ---------------------------------------------------------------------------
loadHubEnv();

const SUPABASE_BASE = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const WORKSPACE_DOMAIN = process.env.NEXT_PUBLIC_WORKSPACE_DOMAIN || 'wwv.local';

function requireSupabaseEnv(): void {
  if (!SUPABASE_BASE || !SERVICE_ROLE) {
    throw new Error('[billing-provisioning-setup-link] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from hub .env.local');
  }
}

/** Service-role call to the hub's Supabase (admin users + PostgREST tables). */
async function supabaseAdmin(path: string, init?: RequestInit): Promise<Response> {
  requireSupabaseEnv();
  return fetch(`${SUPABASE_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
    },
  });
}

async function deleteSupabaseUser(email: string): Promise<void> {
  try {
    const listRes = await supabaseAdmin(`/auth/v1/admin/users?email=${encodeURIComponent(email)}`);
    if (listRes.ok) {
      const list = await listRes.json();
      for (const user of list.users || []) {
        if (user.email === email) {
          await supabaseAdmin(`/auth/v1/admin/users/${user.id}`, { method: 'DELETE' });
          console.log(`[setup-link] Deleted Supabase user ${email}`);
        }
      }
    }
  } catch (e) {
    console.log(`[setup-link] Supabase cleanup error: ${e}`);
  }
}

/** Ensure the hub auth user exists; returns its Supabase UUID. */
async function ensureSupabaseUser(email: string, password: string): Promise<string> {
  const res = await supabaseAdmin('/auth/v1/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { name: 'Setup-Link E2E Tester' },
    }),
  });
  if (res.ok) {
    const created = await res.json();
    console.log(`[setup-link] Supabase user ensured: ${email} (id ${created.id?.slice(0, 8)})`);
    return created.id;
  }
  const body = await res.text();
  if (res.status === 409 || body.includes('already exists') || body.includes('already registered')) {
    const listRes = await supabaseAdmin(`/auth/v1/admin/users?email=${encodeURIComponent(email)}`);
    const list = await listRes.json();
    const existing = (list.users || []).find((u: { email: string }) => u.email === email);
    if (existing) {
      console.log(`[setup-link] Supabase user already exists: ${email} (id ${existing.id?.slice(0, 8)})`);
      return existing.id;
    }
  }
  throw new Error(`[setup-link] Supabase admin create user failed (${res.status}): ${body}`);
}

/**
 * Grant a pro entitlement by inserting a user_entitlements row through the
 * service-role PostgREST API - same mechanism the create spec uses. Without
 * this row the create-instance route returns 403.
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
  console.log(`[setup-link] Pro entitlement granted to user ${userId.slice(0, 8)}`);
}

/** Best-effort removal of any entitlement rows (belt: user delete cascades). */
async function revokeEntitlements(userId: string): Promise<void> {
  try {
    await supabaseAdmin(`/rest/v1/user_entitlements?user_id=eq.${userId}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });
  } catch {
    // Ignore - the Supabase user delete cascades anyway.
  }
}

// ---------------------------------------------------------------------------
// Globe DB access: GlobeDb for user/purge, raw pg for workspace + setup token
// rows (lowercase tables, camelCase quoted columns).
// ---------------------------------------------------------------------------
let globeDb: GlobeDb;
let pgPool: Pool;

async function deleteWorkspaceBySubdomain(subdomain: string): Promise<void> {
  await pgPool.query('DELETE FROM "workspaces" WHERE subdomain = $1', [subdomain]);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Screenshots (UAT gate - vision-model verification artifacts).
// ---------------------------------------------------------------------------
const SHOT_DIR = 'C:/dev/wwv/temp/uat-screenshots';

async function saveScreenshot(page: Page, name: string): Promise<string> {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const p = path.join(SHOT_DIR, name);
  await page.screenshot({ path: p, fullPage: true });
  console.log(`[setup-link] Screenshot saved: ${p}`);
  return p;
}

// ---------------------------------------------------------------------------
// User lifecycle (per-test users, purged in afterAll) - same shape as the
// create spec: fresh state on every side before the test starts.
// ---------------------------------------------------------------------------
interface TestUser {
  email: string;
  supabaseId: string | null;
}

const registered: TestUser[] = [];

async function setupUser(email: string): Promise<TestUser> {
  await globeDb.purgeTestUser(email);
  await deleteSupabaseUser(email);
  await cancelStaleSubscriptions(email);
  // Any stale workspace row for our deterministic subdomain (from a prior run,
  // possibly owned by a different user) must go - the subdomain is globally
  // unique on the globe and a stale row would 409 the fresh create.
  await deleteWorkspaceBySubdomain(SUBDOMAIN);
  const supabaseId = await ensureSupabaseUser(email, PASSWORD);
  const user: TestUser = { email, supabaseId };
  registered.push(user);
  await grantProEntitlement(supabaseId);
  return user;
}

/** Login as a NON-storage-state user on the HUB (Supabase UI login) with the
 *  hydration guard from the create spec (clicking submit before React hydrates
 *  triggers a native GET reload with credentials in the URL). */
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
    console.log(`[setup-link] First login click did not navigate; retrying once`);
    await page.waitForLoadState('domcontentloaded');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    loggedIn = await submitAndWait();
  }
  if (!loggedIn) {
    throw new Error(`[setup-link] Hub UI login failed for ${email}. Final URL: ${page.url()}`);
  }
  await page.waitForTimeout(500); // let the session cookie settle
}

/** Create the instance through the REAL UI create form. The workspace row is
 *  asserted via the globe DB + the UI list by the caller. */
async function createInstanceViaUi(page: Page, subdomain: string): Promise<void> {
  await page.goto('/accounts/instances');
  const createBtn = page.getByRole('button', { name: /create new instance/i });
  await expect(createBtn).toBeVisible({ timeout: 30000 });
  await createBtn.click();

  await page.getByPlaceholder('my-workspace').fill(subdomain);
  await page.getByPlaceholder('My Workspace').fill('Setup Link E2E Workspace');

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
  console.log('[setup-link] create-instance POST 200');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe.configure({ mode: 'serial', timeout: 300000 });

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
      await deleteSupabaseUser(u.email);
      await cancelStaleSubscriptions(u.email);
      await globeDb.purgeTestUser(u.email);
    }
    // Belt: never leave the deterministic workspace behind (independent of
    // which user owns it).
    await deleteWorkspaceBySubdomain(SUBDOMAIN);
    console.log(`[setup-link] Purged ${registered.length} test users + workspace ${SUBDOMAIN}`);
  } finally {
    await globeDb.close();
    await pgPool.end();
  }
});

// ---------------------------------------------------------------------------
// Test 1 - setup-link happy path end-to-end (THE GATE)
// ---------------------------------------------------------------------------
test('provisioning setup-link happy path: hub create -> setup URL -> activation -> login -> globe renders', async ({ page }) => {
  const u = await setupUser(USERS.happy);

  // 1. Create the instance through the real UI.
  await loginAs(page, u.email, PASSWORD);
  await createInstanceViaUi(page, SUBDOMAIN);

  // 2. Workspace lands in the UI list with the subdomain URL shown.
  await expect(page.getByText(`${SUBDOMAIN}.${WORKSPACE_DOMAIN}`, { exact: false })).toBeVisible({
    timeout: 30000,
  });
  console.log('[setup-link] Workspace visible in the instances UI list');

  // 3. The Setup button must be present (the globe status endpoint reports
  //    setupCompleted:false because the provisioned owner is not yet verified).
  const setupBtn = page.getByRole('button', { name: 'Setup', exact: true });
  await expect(setupBtn).toBeVisible({ timeout: 30000 });
  console.log('[setup-link] Setup button visible (status endpoint: setupCompleted=false)');

  // SCREENSHOT 01 - instance created + setup link available.
  await saveScreenshot(page, '01-instance-created.png');

  // 4. Click Setup -> the hub captures a fresh setup token from the globe
  //    (/api/provision) and navigates to the tenant setup URL.
  const setupRespP = page.waitForResponse(
    (r) => r.url().includes('/setup-token') && r.request().method() === 'GET',
    { timeout: 30000 },
  );
  await setupBtn.click();
  const setupResp = await setupRespP;
  // NOTE: do NOT read the response body here — handleSetup sets
  // window.location.href immediately, so by the time waitForResponse resolves
  // the full-page navigation may already have discarded the body
  // ("No resource with given identifier found"). Status + the navigated URL
  // carry the whole contract.
  expect(setupResp.status(), 'setup-token GET must return 200').toBe(200);

  await page.waitForURL(
    (url) => url.hostname === `${SUBDOMAIN}.wwv.local` && url.pathname === '/setup' && url.searchParams.has('token'),
    { timeout: 30000 },
  );
  const setupUrl = new URL(page.url());
  expect(setupUrl.hostname, 'setup URL must be on the tenant subdomain').toBe(`${SUBDOMAIN}.wwv.local`);
  const setupToken = setupUrl.searchParams.get('token')!;
  expect(setupToken, 'setup URL must carry a raw token').toBeTruthy();
  console.log(`[setup-link] setup-token GET ${setupResp.status()}; navigated to ${setupUrl.origin}${setupUrl.pathname}?token=${setupToken.slice(0, 8)}...`);

  // 5. The setup page briefly shows "Validating setup link..." then the
  //    activation form. The validation flash is transient - best-effort
  //    capture, never a gating assertion.
  const validating = page.getByText('Validating setup link...');
  try {
    await validating.waitFor({ state: 'visible', timeout: 5000 });
    console.log('[setup-link] Saw "Validating setup link..." transient');
  } catch {
    console.log('[setup-link] Validation flash too fast to observe (fine)');
  }

  // 6. Activation form appears with the prefilled email (wait on the heading,
  //    NOT the transient loading text).
  await expect(page.getByRole('heading', { name: 'Activate Your Account' })).toBeVisible({ timeout: 30000 });
  const emailInput = page.getByLabel('Email');
  await expect(emailInput).toHaveValue(u.email, { timeout: 10000 });
  console.log('[setup-link] Activation form shown with prefilled email');

  // SCREENSHOT 02 - activation form.
  await saveScreenshot(page, '02-setup-activation-form.png');

  // 7. Fill the activation form and submit.
  await page.getByLabel('Display Name').fill('Setup Link E2E User');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Activate Account' }).click();

  // 8. Activation succeeds -> the setup page pushes to /login.
  await page.waitForURL(
    (url) => url.hostname === `${SUBDOMAIN}.wwv.local` && url.pathname === '/login',
    { timeout: 30000 },
  );
  console.log('[setup-link] Activation succeeded; redirected to /login');

  // 9. Sign in with the just-set password (globe Better Auth login form on
  //    the tenant host). Hydration guard same as hub loginAs.
  await page.waitForFunction(
    () => {
      const form = document.querySelector('form');
      return !!form && Object.keys(form).some((key) => key.startsWith('__reactProps$'));
    },
    undefined,
    { timeout: 60000 },
  );
  await page.fill('input[name="email"]', u.email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');

  // 10. Sign-in redirects to the tenant root -> the globe app renders.
  await page.waitForURL(
    (url) => url.hostname === `${SUBDOMAIN}.wwv.local` && url.pathname === '/',
    { timeout: 30000 },
  );
  await expect(page.getByTestId('app-ready')).toBeVisible({ timeout: 60000 });
  console.log('[setup-link] Post-login globe app rendered ([data-testid=app-ready])');

  // SCREENSHOT 03 - post-login globe.
  await saveScreenshot(page, '03-globe-rendered.png');

  // 11. LAYERED DB ASSERTIONS (globe DB, lowercase tables):
  //     (a) user.emailVerified = true
  //     (b) the setup token row's usedAt is consumed
  //     (c) the workspace row exists: status active + owned by this user
  const userRes = await pgPool.query<{ id: string; emailVerified: boolean }>(
    'SELECT id, "emailVerified" FROM "user" WHERE email = $1 LIMIT 1',
    [u.email],
  );
  expect(userRes.rows[0], `globe user ${u.email} must exist`).toBeTruthy();
  expect(userRes.rows[0].emailVerified, 'activation must set emailVerified=true').toBe(true);

  const tokenRes = await pgPool.query<{ usedAt: Date | null }>(
    'SELECT "usedAt" FROM "setup_tokens" WHERE "tokenHash" = $1 LIMIT 1',
    [sha256Hex(setupToken)],
  );
  expect(tokenRes.rows[0], 'setup token row must exist (hashed in setup_tokens)').toBeTruthy();
  expect(tokenRes.rows[0].usedAt, 'activation must consume the setup token (usedAt set)').not.toBeNull();

  const wsRes = await pgPool.query<{ status: string; ownerId: string }>(
    'SELECT status, "ownerId" FROM "workspaces" WHERE subdomain = $1 LIMIT 1',
    [SUBDOMAIN],
  );
  expect(wsRes.rows[0], `workspace ${SUBDOMAIN} must exist`).toBeTruthy();
  expect(wsRes.rows[0].status, 'workspace must remain active after activation').toBe('active');
  expect(wsRes.rows[0].ownerId, 'workspace owner must be the provisioned globe user').toBe(userRes.rows[0].id);
  console.log('[setup-link] DB verified: emailVerified=true, setup token consumed, workspace active + owned by user');
});

// ---------------------------------------------------------------------------
// Test 2 - invalid setup token (negative). Runs on the ROOT domain so it is
// independent of test 1's workspace row: the globe proxy keeps /setup public
// and the setup page itself validates the token against setup_tokens.
// ---------------------------------------------------------------------------
test('provisioning setup-link invalid token: /setup?token=DEADBEEF shows "Invalid Setup Link"', async ({ page }) => {
  await page.goto('https://wwv.local/setup?token=DEADBEEF', { timeout: 90000 });

  // The setup page validates the bogus token and renders the invalid state.
  await expect(page.getByRole('heading', { name: 'Invalid Setup Link' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText(/invalid or (has )?expired/i)).toBeVisible({ timeout: 10000 });
  console.log('[setup-link] Invalid setup token rendered "Invalid Setup Link"');

  // SCREENSHOT 04 - negative case (bonus artifact for the vision gate).
  await saveScreenshot(page, '04-invalid-setup-link.png');
});
