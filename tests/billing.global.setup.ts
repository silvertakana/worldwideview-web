/* eslint-disable no-console */
import { chromium, type FullConfig } from '@playwright/test';
import { GlobeDb } from './lib/globe-db';
import { loadHubEnv } from './lib/env';
import fs from 'fs';
import path from 'path';

export const TEST_EMAIL = 'billing-e2e@worldwideview.local';
export const TEST_PASSWORD = 'BillingE2E-2026!!';
export const TEST_ORG_SLUG = 'billing-e2e-org';
export const TEST_WORKSPACE_SUBDOMAIN = 'billing-e2e-ws';

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
          console.log(`[billing-setup] Deleted Supabase user ${email}`);
        }
      }
    }
  } catch (e) {
    console.log(`[billing-setup] Supabase cleanup error: ${e}`);
  }
}

async function createSupabaseUser(email: string, password: string): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('[billing-setup] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from hub .env.local');
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
      user_metadata: { name: 'Billing E2E Tester' },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (!(res.status === 409 || body.includes('already exists') || body.includes('already registered'))) {
      throw new Error(`[billing-setup] Supabase admin create user failed (${res.status}): ${body}`);
    }
  }
  console.log(`[billing-setup] Supabase user ensured: ${email}`);
}

async function seedGlobeDb() {
  const globeDb = new GlobeDb();
  try {
    for (let i = 0; i < 5; i++) {
      try {
        await globeDb.ping();
        break;
      } catch {
        console.log(`[billing-setup] Waiting for database (attempt ${i + 1}/5)...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    // Defensive cleanup of prior runs, then a fresh seed.
    await globeDb.purgeTestUser(TEST_EMAIL);
    const userId = await globeDb.seedTestUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      orgSlug: TEST_ORG_SLUG,
      workspaceSubdomain: TEST_WORKSPACE_SUBDOMAIN,
    });

    console.log(`[billing-setup] Globe seeded: user ${TEST_EMAIL}, org, workspace, org_tier=free`);
    return userId;
  } finally {
    await globeDb.close();
  }
}

async function loginToHubAndSaveStorage(baseURL: string, storageState: string) {
  // Direct launch does NOT inherit the config's project-level
  // ignoreHTTPSErrors: true; the dev stack serves https://hub.wwv.local with
  // a self-signed cert, so the login page would fail with
  // net::ERR_CERT_AUTHORITY_INVALID without this option.
  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    // 90s: the hub runs `next dev` in CI, so /login cold-compiles on first
    // hit. Under loaded runners that has exceeded the old 30s cap twice in a
    // row (billing-e2e run 31146470100 / 31148499219). The workflow's
    // readiness step now pre-warms /login + /accounts/billing, but keep the
    // generous timeout as a safety net for slower compile bursts.
    await page.goto(`${baseURL}/login`, { timeout: 90000 });
    await page.fill('input[name="email"]', TEST_EMAIL);
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    try {
      // Pathname-based check — a regex on the full URL would falsely match
      // "//hub" inside the host "hub.wwv.local" and resolve before the
      // session cookie is committed.
      await page.waitForURL(
        (url) =>
          url.pathname.startsWith('/pricing') ||
          url.pathname.startsWith('/accounts') ||
          url.pathname.startsWith('/hub'),
        { timeout: 25000 },
      );
      await page.waitForTimeout(1500); // let the session cookie settle
    } catch {
      const url = page.url();
      const errorText = await page.getByText(/invalid|credential|error/i).first().textContent().catch(() => '');
      throw new Error(
        `[billing-setup] UI login failed. Final URL: ${url}${errorText ? ` | page error: ${errorText}` : ''}`,
      );
    }
    console.log(`[billing-setup] UI login ok, landed at ${new URL(page.url()).pathname}`);
  } finally {
    const dir = path.dirname(storageState);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await page.context().storageState({ path: storageState });
    console.log(`[billing-setup] Storage state saved: ${storageState}`);
    await browser.close();
  }
}

async function globalSetup(config: FullConfig) {
  loadHubEnv();
  const storageState = config.projects[0].use.storageState;
  const baseURL = config.projects[0].use.baseURL;
  if (typeof storageState !== 'string' || !baseURL) {
    throw new Error('[billing-setup] storageState / baseURL not defined in config');
  }

  await deleteSupabaseUser(TEST_EMAIL);
  await seedGlobeDb();
  await createSupabaseUser(TEST_EMAIL, TEST_PASSWORD);
  await loginToHubAndSaveStorage(baseURL, storageState);
  console.log('[billing-setup] Global setup complete.');
}

export default globalSetup;
