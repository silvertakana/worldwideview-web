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
 * ENTITLEMENT MECHANISM — the create-instance route is gated:
 *   src/app/api/provisioning/instance/route.ts -> hasInstanceEntitlement()
 *   reads supabase `user_entitlements` rows with revoked_at IS NULL and
 *   returns 403 "No active entitlement..." without one. This suite grants
 *   entitlement by INSERTING a user_entitlements row via the service-role
 *   PostgREST API (/rest/v1/user_entitlements — the same API surface
 *   createAdminClient() uses), exactly mirroring what
 *   src/app/accounts/redeem/actions.ts does for a redeemed code. The
 *   user_id FK is ON DELETE CASCADE (migration
 *   20260703000001_create_access_codes.sql), so deleting the Supabase user
 *   in teardown removes the entitlement rows too.
 *
 * TEST USERS — each test seeds its OWN fresh user so every test starts from
 * a known state (billing-provision pattern), and purges it in afterAll.
 * Stripe hygiene (cancelStaleSubscriptions) runs per-user so a recycled
 * shared-account customer can never render a free user as paid via
 * getHubTierFallback's email match.
 *
 * KNOWN SERVER-SIDE LIMITATION (discovered while writing this suite, NOT
 * fixed — scope is one spec file):
 *   The billing page's "Instances: X of Unlimited" line reads instanceCount
 *   ONLY from the globe tier endpoint (src/app/accounts/billing/page.tsx:
 *   data.instanceCount ?? 0), but the globe's /api/service/tier response
 *   (globe src/lib/org-tier.ts getOrgTier) returns only {tier, status,
 *   trialEndsAt} — never instanceCount. So the billing page ALWAYS renders
 *   "Instances: 0 of Unlimited used" and the zero-instance CTA
 *   (instanceCount === 0) NEVER disappears, even after a workspace exists.
 *   The test-plan expectation "billing shows 1 of Unlimited and NO CTA" is
 *   therefore NOT achievable against current server code. This spec asserts
 *   the factual state (billing renders the 0-of-Unlimited line) and pins
 *   the CTA's persistence as a documented product gap; the create-success
 *   signal is asserted on the REAL surfaces: the workspace row in the globe
 *   DB and the workspace in the /accounts/instances UI list.
 */

export const PASSWORD = 'Provisioning-2026!!';

const USERS = {
  cta: 'billing-create-cta@worldwideview.local',
  happy: 'billing-create-happy@worldwideview.local',
  invalid: 'billing-create-invalid@worldwideview.local',
  dup: 'billing-create-dup@worldwideview.local',
  noent: 'billing-create-noent@worldwideview.local',
  banner: 'billing-create-banner@worldwideview.local',
};

// ---------------------------------------------------------------------------
// Env loading (worker processes do NOT inherit env set in globalSetup).
// ---------------------------------------------------------------------------
loadHubEnv();

const SUPABASE_BASE = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const WORKSPACE_DOMAIN = process.env.NEXT_PUBLIC_WORKSPACE_DOMAIN || 'cloud-wwv.dev';

function requireSupabaseEnv(): void {
  if (!SUPABASE_BASE || !SERVICE_ROLE) {
    throw new Error('[billing-provisioning-create] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from hub .env.local');
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
          console.log(`[provisioning-create] Deleted Supabase user ${email}`);
        }
      }
    }
  } catch (e) {
    console.log(`[provisioning-create] Supabase cleanup error: ${e}`);
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
      user_metadata: { name: 'Provisioning E2E Tester' },
    }),
  });
  if (res.ok) {
    const created = await res.json();
    console.log(`[provisioning-create] Supabase user ensured: ${email} (id ${created.id?.slice(0, 8)})`);
    return created.id;
  }
  const body = await res.text();
  if (res.status === 409 || body.includes('already exists') || body.includes('already registered')) {
    // Re-list to fetch the existing user's id.
    const listRes = await supabaseAdmin(`/auth/v1/admin/users?email=${encodeURIComponent(email)}`);
    const list = await listRes.json();
    const existing = (list.users || []).find((u: { email: string }) => u.email === email);
    if (existing) {
      console.log(`[provisioning-create] Supabase user already exists: ${email} (id ${existing.id?.slice(0, 8)})`);
      return existing.id;
    }
  }
  throw new Error(`[provisioning-create] Supabase admin create user failed (${res.status}): ${body}`);
}

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

async function setupUser(email: string, opts: { entitlement?: boolean } = {}): Promise<TestUser> {
  // Fresh state on every side: no globe rows, no hub auth user, no live subs.
  await globeDb.purgeTestUser(email);
  await deleteSupabaseUser(email);
  await cancelStaleSubscriptions(email);
  const supabaseId = await ensureSupabaseUser(email, PASSWORD);
  const user: TestUser = { email, supabaseId, entitled: !!opts.entitlement };
  registered.push(user);
  if (opts.entitlement) await grantProEntitlement(supabaseId);
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
      await deleteSupabaseUser(u.email);
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
  const u = await setupUser(USERS.happy, { entitlement: true });
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

  // Billing page post-create state. NOTE (see header): two facts make the
  // test-plan's "1 of Unlimited and NO CTA" unreachable against the current
  // server code:
  //   1. The globe tier endpoint (/api/service/tier, getOrgTier in the globe
  //      repo) returns only {tier,status,trialEndsAt} — never instanceCount —
  //      so the billing page's instanceCount is always 0 and the CTA
  //      (instanceCount === 0) never disappears.
  //   2. A UI create-instance alone never writes org_tiers (that happens on
  //      tier-sync after payment), so the billing mirror still reports
  //      tier=free -> Local plan. The "Instances: X of Y" line only renders
  //      for non-local plans.
  // Assert the factual state: the page still shows Local/Free + CTA after a
  // create (pinning the gap), and the "Instances:" line is absent.
  await page.goto('/accounts/billing');
  await expect(page.getByText(/You are on the Free plan\./)).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('link', { name: /create your first instance/i })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByText(/Instances: \d+ of/)).toHaveCount(0);
  console.log('[provisioning-create] Billing page: Local/Free + CTA persists after create (known globe-tier gap)');
});

// ---------------------------------------------------------------------------
// Test 3 — invalid subdomain client validation
// ---------------------------------------------------------------------------
test('provisioning-create invalid subdomain: client validation blocks submit, no globe call', async ({ page }) => {
  const u = await setupUser(USERS.invalid, { entitlement: true });
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
  const u = await setupUser(USERS.dup, { entitlement: true });
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
// Test 5 — no entitlement
// ---------------------------------------------------------------------------
test('provisioning-create no entitlement: instances page shows redeem block, POST is 403', async ({ page }) => {
  const u = await setupUser(USERS.noent); // deliberately NO entitlement
  await loginAs(page, u.email, PASSWORD);
  await page.goto('/accounts/instances');

  // The UI renders the redeem block instead of the create button. Scope to the
  // inner content main — the account layout nests the sidebar inside an outer
  // <main>, and the sidebar ALSO has a "Redeem Code" nav link.
  const content = page.locator('main main');
  await expect(page.getByText(/You need an access code to create an instance/)).toBeVisible({ timeout: 30000 });
  await expect(content.getByRole('link', { name: /redeem code/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /create new instance/i })).toHaveCount(0);

  // The route itself rejects with the exact message hasInstanceEntitlement
  // produces when no user_entitlements row exists.
  const res = await page.request.post('/api/provisioning/instance', {
    data: { subdomain: `noent-${Date.now().toString(36)}`, name: 'No Entitlement' },
  });
  expect(res.status(), `no-entitlement POST should 403, got ${res.status()}`).toBe(403);
  const body = await res.json();
  expect(body.error).toContain('No active entitlement');
  console.log('[provisioning-create] Redeem block shown; direct POST rejected 403 "No active entitlement"');
});

// ---------------------------------------------------------------------------
// Test 6 — silent-skip banner
// ---------------------------------------------------------------------------
test('provisioning-create silent-skip banner: shows for paid-but-unprovisioned, clears after provision succeeds', async ({ page }) => {
  const u = await setupUser(USERS.banner, { entitlement: true });

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
  await expect(page.getByText(/Pro - Trial/i)).toBeVisible({ timeout: 10000 });
  console.log('[provisioning-create] Banner cleared after provisioning + tier-sync (Pro - Trial shown)');
});
