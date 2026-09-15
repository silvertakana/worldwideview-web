/* eslint-disable no-console */
import { GlobeDb } from './lib/globe-db';
import { loadHubEnv } from './lib/env';
import { cancelStaleSubscriptions } from './lib/stripe';
import { deleteSupabaseUserByEmail } from './lib/supabase-admin';

export const TEST_EMAIL = 'billing-e2e@worldwideview.local';

async function globalTeardown() {
  loadHubEnv();

  // Leave clean state for the NEXT run: cancel any live Stripe subscription for
  // the test user (the globe/Supabase purge below never cancelled subs, which
  // is how leftovers accumulated across CI runs). Best-effort — the helper
  // swallows errors and logs.
  await cancelStaleSubscriptions(TEST_EMAIL);

  await deleteSupabaseUserByEmail(TEST_EMAIL);

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
