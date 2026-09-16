import { createAdminClient } from "@/lib/supabase/admin";
import { asMessage, type BillingOverride, type SubscriptionRecord } from "@/lib/billing/billing-tables";
import { getActiveOverride, getSubscriptionByEmail, listOverridesForUser } from "@/lib/billing/subscription-store";
import { getUserEntitlements, type Entitlement } from "@/lib/auth/entitlements";
import type { GlobeReadResult } from "@/lib/billing/globe-tiers";

/**
 * The operator's view of one customer: everything the hub knows, assembled in
 * one read so the screen can show it on one page.
 *
 * The pieces come from four places and none of them is the whole truth:
 *
 *   billing_subscriptions  the durable record (Stripe-owned, or an operator's manual row)
 *   billing_overrides      the operator's own grants, active and revoked (the audit trail)
 *   user_entitlements      code redemptions
 *   Supabase Auth          the identity itself, and the email the globe is keyed on
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERS_PER_PAGE = 200;
const MAX_USER_PAGES = 25;
const MAX_ACTOR_LOOKUPS = 10;

export interface OperatorCustomer {
  userId: string;
  email: string;
  createdAt: string | null;
  /** The durable billing record, or null when the hub has nothing on file. */
  subscription: SubscriptionRecord | null;
  /** The single active operator override, or null. */
  override: BillingOverride | null;
  /** Every override ever granted to this customer, newest first. */
  history: BillingOverride[];
  entitlements: Entitlement[];
  /** Actor user id -> email, for the audit trail. Unresolvable ids are absent. */
  actors: Record<string, string>;
}

export type CustomerLookupResult = { ok: true; customer: OperatorCustomer } | { ok: false; error: string };

/** What the lookup action returns: the customer plus the globe's own view. */
export type LookupResult =
  | { ok: true; customer: OperatorCustomer; globe: GlobeReadResult }
  | { ok: false; error: string };

interface HubUser {
  id: string;
  email: string;
  createdAt: string | null;
}

async function getHubUserById(userId: string): Promise<HubUser | null> {
  const { data, error } = await createAdminClient().auth.admin.getUserById(userId);
  if (error || !data?.user?.email) return null;
  return { id: data.user.id, email: data.user.email, createdAt: data.user.created_at ?? null };
}

/**
 * Supabase's admin API has no "find a user by email" call - listUsers takes only
 * page/perPage - so an email resolves by walking the user list in bounded pages
 * and matching exactly. The durable billing record short-circuits the walk for
 * anyone the hub has ever billed, which is the common case.
 *
 * `scannedAll` is false when the page cap was hit, so the caller can say
 * "not found in the first N accounts" rather than the stronger and possibly
 * false "no such account".
 */
async function findUserByEmail(email: string): Promise<{ user: HubUser | null; scannedAll: boolean }> {
  const ledger = await getSubscriptionByEmail(email);
  if (ledger?.user_id) {
    const known = await getHubUserById(ledger.user_id);
    if (known) return { user: known, scannedAll: true };
  }

  const admin = createAdminClient();
  const wanted = email.toLowerCase();

  for (let page = 1; page <= MAX_USER_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: USERS_PER_PAGE });
    if (error) throw new Error(`[billing] listUsers failed: ${error.message}`);
    const users = data?.users ?? [];
    if (users.length === 0) return { user: null, scannedAll: true };

    const match = users.find((candidate) => (candidate.email ?? "").toLowerCase() === wanted);
    if (match?.email) {
      return { user: { id: match.id, email: match.email, createdAt: match.created_at ?? null }, scannedAll: true };
    }
  }

  return { user: null, scannedAll: false };
}

function notFoundMessage(trimmed: string, scannedAll: boolean): string {
  return scannedAll
    ? `Supabase Auth has no user with the email ${trimmed}. Check the spelling, or paste the user id instead.`
    : `Searched the first ${MAX_USER_PAGES * USERS_PER_PAGE} hub accounts without finding ${trimmed}. ` +
        "Paste the user id instead.";
}

/**
 * Resolves what an operator typed - an email address or a hub user id - to a
 * customer. A customer with no billing record at all is still a customer here:
 * the ledger being empty is information the screen must show, not an error.
 */
export async function findCustomer(query: string): Promise<CustomerLookupResult> {
  const trimmed = query.trim();
  if (!trimmed) return { ok: false, error: "Enter a customer email address or hub user id." };

  try {
    if (UUID_PATTERN.test(trimmed)) {
      const user = await getHubUserById(trimmed);
      if (!user) return { ok: false, error: `Supabase Auth has no user with the id ${trimmed}.` };
      return { ok: true, customer: await loadCustomer(user) };
    }

    const found = await findUserByEmail(trimmed);
    if (!found.user) return { ok: false, error: notFoundMessage(trimmed, found.scannedAll) };
    return { ok: true, customer: await loadCustomer(found.user) };
  } catch (err) {
    return { ok: false, error: `Could not read the customer's records: ${asMessage(err)}` };
  }
}

async function loadCustomer(user: HubUser): Promise<OperatorCustomer> {
  const [subscription, override, history, entitlements] = await Promise.all([
    getSubscriptionByEmail(user.email),
    getActiveOverride(user.id),
    listOverridesForUser(user.id),
    getUserEntitlements(user.id),
  ]);

  return {
    userId: user.id,
    email: user.email,
    createdAt: user.createdAt,
    subscription,
    override,
    history,
    entitlements,
    actors: await resolveActorEmails(user.id, history),
  };
}

/** The audit trail has to name people, not uuids. Capped so a long history cannot fan out. */
async function resolveActorEmails(userId: string, history: BillingOverride[]): Promise<Record<string, string>> {
  const ids = new Set<string>();
  for (const row of history) {
    if (row.created_by) ids.add(row.created_by);
    if (row.revoked_by) ids.add(row.revoked_by);
    if (ids.size >= MAX_ACTOR_LOOKUPS) break;
  }
  ids.delete(userId);

  const actors: Record<string, string> = {};
  for (const id of ids) {
    const actor = await getHubUserById(id);
    if (actor) actors[id] = actor.email;
  }
  return actors;
}
