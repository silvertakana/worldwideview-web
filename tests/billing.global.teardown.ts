/* eslint-disable no-console */
import { GlobeDb } from './lib/globe-db';
import { loadHubEnv } from './lib/env';
import { cancelStaleSubscriptions } from './lib/stripe';

export const TEST_EMAIL = 'billing-e2e@worldwideview.local';

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
          console.log(`[billing-teardown] Deleted Supabase user ${email}`);
        }
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

async function globalTeardown() {
  loadHubEnv();

  // Leave clean state for the NEXT run: cancel any live Stripe subscription for
  // the test user (the globe/Supabase purge below never cancelled subs, which
  // is how leftovers accumulated across CI runs). Best-effort — the helper
  // swallows errors and logs.
  await cancelStaleSubscriptions(TEST_EMAIL);

  await deleteSupabaseUser(TEST_EMAIL);

  const globeDb = new GlobeDb();
  try {
    await globeDb.purgeTestUser(TEST_EMAIL);
    console.log(`[billing-teardown] Globe test rows purged for ${TEST_EMAIL}`);
  } catch (e) {
    console.error(`[billing-teardown] Globe cleanup error:`, e);
  } finally {
    await globeDb.close();
  }
}

export default globalTeardown;
