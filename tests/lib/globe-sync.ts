/* eslint-disable no-console */
import crypto from 'node:crypto';

/**
 * Direct HMAC-signed calls to the GLOBE's cross-service endpoints
 * (/api/service/tier-sync, /api/provision).
 *
 * These mirror the hub's crossServiceFetch() (src/lib/cross-service/sign.ts +
 * fetch.ts) and are the CI-verified path the billing suite uses when the
 * hosted Stripe checkout card payment is not automatable: Stripe's hosted
 * page runs an invisible hCaptcha that blocks payment submission from CI
 * datacenter IPs (a Stripe-owned bot wall with no controllable fix). Tests
 * 2-3 already pass in CI via this direct path; tests 4-5 use the same
 * verified-endpoints approach.
 *
 * GLOBE-SPECIFIC DEPENDENCY: requires the globe to be reachable at GLOBE_URL
 * (default http://localhost:3000) with CROSS_SERVICE_SECRET matching the
 * globe's env (the docker test stack uses wwv-test-hmac-secret-2026; the dev
 * stack uses dev-hmac-secret-1678404173).
 */
export const GLOBE_URL = process.env.GLOBE_URL || 'http://localhost:3000';

const CROSS_SERVICE_SECRET =
  process.env.CROSS_SERVICE_SECRET || 'dev-hmac-secret-1678404173';

/**
 * Same canonical string as src/lib/cross-service/sign.ts: path WITHOUT the
 * query string (the globe verifier builds it from request.url pathname).
 */
export function signCrossServiceRequest(
  method: string,
  pathName: string,
  body?: Record<string, unknown>,
): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const bodyStr = body !== undefined ? JSON.stringify(body) : '';
  const bodyHash = crypto.createHash('sha256').update(bodyStr, 'utf8').digest('hex');
  const signedPath = pathName.split('?')[0];
  const canon = `${method}\n${signedPath}\n${timestamp}\n${bodyHash}`;
  const sig = crypto.createHmac('sha256', CROSS_SERVICE_SECRET).update(canon, 'utf8').digest('hex');
  return `t=${timestamp},n=${nonce},sig=${sig}`;
}

/**
 * Direct HMAC tier sync to the globe (/api/service/tier-sync) — the same call
 * the hub's webhook handler makes. The globe's setOrgTier() upserts
 * org_tiers and unlocks/locks the owner's workspace on upgrade/downgrade.
 * Throws on non-2xx (tier-sync 404s when the email has no globe org — call
 * provisionGlobeUser first for fresh users).
 */
export async function directTierSync(
  email: string,
  tier: string,
  status: string,
): Promise<void> {
  const body = { email, tier, status };
  const sigHeader = signCrossServiceRequest('POST', '/api/service/tier-sync', body);
  const res = await fetch(`${GLOBE_URL}/api/service/tier-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Signature': sigHeader },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`[globe-sync] direct tier-sync ${email} ${tier}/${status} -> ${res.status} ${text.slice(0, 80)}`);
  if (!res.ok) {
    throw new Error(`tier-sync ${tier}/${status} for ${email} failed (${res.status}): ${text}`);
  }
}

/**
 * Provision a globe user + org + owner membership via the globe's HMAC
 * /api/provision endpoint — the same call the hub's webhook makes on
 * checkout.session.completed (src/lib/billing/provision.ts, which forwards
 * the auth-gated /api/provisioning/workspace route). Idempotent: an existing
 * user gets a fresh setup token instead of a 409. Throws on non-2xx.
 */
export async function provisionGlobeUser(
  email: string,
  hubUserId: string,
  name: string,
): Promise<void> {
  const body = { email, name, hubUserId };
  const sigHeader = signCrossServiceRequest('POST', '/api/provision', body);
  const res = await fetch(`${GLOBE_URL}/api/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Signature': sigHeader },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`[globe-sync] provision ${email} -> ${res.status} ${text.slice(0, 80)}`);
  if (!res.ok) {
    throw new Error(`provision for ${email} failed (${res.status}): ${text}`);
  }
}
