/* eslint-disable no-console */

/**
 * Service-role Supabase admin helpers shared by the billing E2E suite.
 *
 * GoTrue (pinned at v2.192.0 in supabase/.temp/gotrue-version) serves the admin
 * user list from `GET /auth/v1/admin/users`, and that handler reads only
 * `page`, `per_page`, `sort` and `filter` off the query string
 * (internal/api/admin.go adminUsers -> paginate + sort). There is NO email
 * filter: an `?email=` parameter is silently ignored, and the endpoint answers
 * with a `created_at DESC` window of the whole user table (default 50 rows).
 *
 * Seeking a user by reading that default window therefore only works while the
 * account happens to sit among the newest 50 in the project. Once enough newer
 * accounts exist the lookup quietly returns nothing, the surrounding setup
 * becomes vacuous, and the suite still reports green - the failure shape this
 * module removes. Every lookup here pages the endpoint properly and raises a
 * loud, attributed error rather than returning a silent `undefined`.
 */

export interface SupabaseAdminUser {
  id: string;
  email?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Rows requested per `per_page` page. */
export const ADMIN_USERS_PAGE_SIZE = 200;

/** Page ceiling walked before a lookup declares itself unable to prove absence. */
export const ADMIN_USERS_MAX_PAGES = 50;

/** Raised whenever an admin-API lookup cannot produce a defensible answer. */
export class SupabaseAdminLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseAdminLookupError';
  }
}

export interface SupabaseAdminOptions {
  fetchImpl?: FetchLike;
  pageSize?: number;
  maxPages?: number;
}

function adminCredentials(): { base: string; serviceRole: string } {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base || !serviceRole) {
    throw new SupabaseAdminLookupError(
      '[supabase-admin] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from hub .env.local',
    );
  }
  return { base, serviceRole };
}

/** Service-role call to Supabase (GoTrue admin API + PostgREST tables). */
export async function supabaseAdmin(
  path: string,
  init?: RequestInit,
  opts: SupabaseAdminOptions = {},
): Promise<Response> {
  const { base, serviceRole } = adminCredentials();
  const doFetch = opts.fetchImpl ?? fetch;
  return doFetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
    },
  });
}

interface AdminUsersPage {
  users?: SupabaseAdminUser[];
}

interface AdminUsersWalk {
  user: SupabaseAdminUser | null;
  pagesSearched: number;
  rowsInspected: number;
}

/**
 * Page `GET /auth/v1/admin/users` until `email` is found or the table is
 * provably exhausted.
 *
 * `user` is `null` only when the walk reached a short page, which is proof
 * there are no further rows. A failed page request, or hitting the page
 * ceiling first, throws: at that point absence is unknown, and reporting
 * unknown as absence is the silent failure this helper exists to prevent.
 */
async function walkAdminUsers(email: string, opts: SupabaseAdminOptions = {}): Promise<AdminUsersWalk> {
  const pageSize = opts.pageSize ?? ADMIN_USERS_PAGE_SIZE;
  const maxPages = opts.maxPages ?? ADMIN_USERS_MAX_PAGES;
  const target = email.toLowerCase();
  let rowsInspected = 0;

  for (let page = 1; page <= maxPages; page++) {
    const res = await supabaseAdmin(`/auth/v1/admin/users?page=${page}&per_page=${pageSize}`, undefined, opts);
    if (!res.ok) {
      throw new SupabaseAdminLookupError(
        `[supabase-admin] GET /auth/v1/admin/users page ${page} failed (${res.status}) while looking up ${email}. ` +
          `Searched ${page - 1} full page(s) before the failure, so existence is unknown.`,
      );
    }

    const body = (await res.json()) as AdminUsersPage;
    const users = Array.isArray(body?.users) ? body.users : [];
    rowsInspected += users.length;

    const match = users.find((u) => (u.email || '').toLowerCase() === target);
    if (match) return { user: match, pagesSearched: page, rowsInspected };

    // A short page is the end of the table - absence is now proven.
    if (users.length < pageSize) return { user: null, pagesSearched: page, rowsInspected };
  }

  throw new SupabaseAdminLookupError(
    `[supabase-admin] ${email} was not found after searching ${maxPages} page(s) of ${pageSize} rows ` +
      `(${rowsInspected} rows inspected), and the page ceiling was reached before the table ended. ` +
      `Absence is unproven - raise pageSize or maxPages if this project legitimately holds more users.`,
  );
}

/** Resolve a user by email, paging the admin list. `null` means provably absent. */
export async function findSupabaseUserByEmail(
  email: string,
  opts: SupabaseAdminOptions = {},
): Promise<SupabaseAdminUser | null> {
  return (await walkAdminUsers(email, opts)).user;
}

/** Resolve a user by email, throwing when the account does not exist. */
export async function requireSupabaseUserByEmail(
  email: string,
  opts: SupabaseAdminOptions = {},
): Promise<SupabaseAdminUser> {
  const { user, pagesSearched, rowsInspected } = await walkAdminUsers(email, opts);
  if (!user) {
    throw new SupabaseAdminLookupError(
      `[supabase-admin] no Supabase user exists for ${email}. ` +
        `Searched the entire admin user list (${pagesSearched} page(s), ${rowsInspected} row(s) inspected).`,
    );
  }
  return user;
}

/**
 * Delete the Supabase user matching `email`, paging to find it first.
 * Returns false, with an explicit log line, when the account is provably gone.
 */
export async function deleteSupabaseUserByEmail(
  email: string,
  opts: SupabaseAdminOptions = {},
): Promise<boolean> {
  const { user, pagesSearched, rowsInspected } = await walkAdminUsers(email, opts);
  if (!user) {
    console.log(
      `[supabase-admin] no Supabase user to delete for ${email} ` +
        `(searched ${pagesSearched} page(s), ${rowsInspected} row(s))`,
    );
    return false;
  }

  const res = await supabaseAdmin(`/auth/v1/admin/users/${user.id}`, { method: 'DELETE' }, opts);
  if (!res.ok) {
    throw new SupabaseAdminLookupError(
      `[supabase-admin] DELETE /auth/v1/admin/users/${user.id} failed (${res.status}) for ${email}`,
    );
  }
  console.log(`[supabase-admin] Deleted Supabase user ${email}`);
  return true;
}

/**
 * Ensure the hub auth user exists and return its Supabase UUID.
 *
 * The id is taken from the create response, so the happy path never searches.
 * The paged lookup runs only to recover an id after a 409, and throws when the
 * account is reported as existing but the admin list cannot produce it.
 */
export async function ensureSupabaseUser(
  email: string,
  password: string,
  displayName: string,
  opts: SupabaseAdminOptions = {},
): Promise<string> {
  const res = await supabaseAdmin(
    '/auth/v1/admin/users',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { name: displayName },
      }),
    },
    opts,
  );

  if (res.ok) {
    const created = (await res.json()) as SupabaseAdminUser;
    if (!created?.id) {
      throw new SupabaseAdminLookupError(
        `[supabase-admin] create-user response for ${email} carried no id - cannot track the account`,
      );
    }
    console.log(`[supabase-admin] Supabase user ensured: ${email} (id ${created.id.slice(0, 8)})`);
    return created.id;
  }

  const body = await res.text();
  if (res.status === 409 || body.includes('already exists') || body.includes('already registered')) {
    const existing = await requireSupabaseUserByEmail(email, opts);
    console.log(`[supabase-admin] Supabase user already exists: ${email} (id ${existing.id.slice(0, 8)})`);
    return existing.id;
  }

  throw new SupabaseAdminLookupError(
    `[supabase-admin] Supabase admin create user failed (${res.status}): ${body}`,
  );
}
