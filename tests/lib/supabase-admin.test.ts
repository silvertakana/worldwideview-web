import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  deleteSupabaseUserByEmail,
  ensureSupabaseUser,
  findSupabaseUserByEmail,
  requireSupabaseUserByEmail,
  SupabaseAdminLookupError,
  type FetchLike,
} from './supabase-admin';

/**
 * Guards the regression that made the billing E2E setup vacuous:
 * `GET /auth/v1/admin/users?email=...` ignores the `email` parameter and
 * returns a created_at-DESC window of the whole user table, so reading page 1
 * only finds a user while that user sits among the newest rows.
 */

const BASE = 'https://test-project.supabase.co';
const KEY = 'test-service-role-key';

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

/** Duck-typed Response: the jsdom environment does not guarantee a global Response. */
function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

function usersPage(emails: string[]) {
  return { users: emails.map((email) => ({ id: `id-${email}`, email })) };
}

/** Emails for a full page of accounts that are NOT the lookup target. */
function decoys(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `unrelated-${i}@example.test`);
}

const target = 'billing-e2e@worldwideview.local';

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

describe('findSupabaseUserByEmail', () => {
  it('finds a user that is NOT on page 1 (the old page-1-only read missed it)', async () => {
    const { fetchImpl, calls } = stubFetch((url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return page === 1 ? jsonResponse(usersPage(decoys(50))) : jsonResponse(usersPage([target]));
    });

    const user = await findSupabaseUserByEmail(target, { fetchImpl, pageSize: 50 });

    expect(user?.id).toBe(`id-${target}`);
    expect(calls).toHaveLength(2);
    const requested = calls.map((c) => new URL(c.url));
    expect(requested[0].searchParams.get('page')).toBe('1');
    expect(requested[0].searchParams.get('per_page')).toBe('50');
    expect(requested[1].searchParams.get('page')).toBe('2');
    expect(requested[1].searchParams.get('per_page')).toBe('50');
  });

  it('defaults to a 200-row page (GoTrue would otherwise serve 50)', async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(usersPage([target])));

    await findSupabaseUserByEmail(target, { fetchImpl });

    expect(new URL(calls[0].url).searchParams.get('per_page')).toBe('200');
  });

  it('never sends the unsupported email parameter', async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(usersPage([target])));

    await findSupabaseUserByEmail(target, { fetchImpl });

    for (const call of calls) {
      expect(new URL(call.url).searchParams.has('email')).toBe(false);
      expect(call.url).not.toContain('email=');
    }
  });

  it('matches case-insensitively', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(usersPage(['Billing-E2E@WorldWideView.Local'])));

    const user = await findSupabaseUserByEmail(target, { fetchImpl });

    expect(user?.email).toBe('Billing-E2E@WorldWideView.Local');
  });

  it('returns null only after walking to a short page', async () => {
    const { fetchImpl, calls } = stubFetch((url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return page === 1 ? jsonResponse(usersPage(decoys(2))) : jsonResponse(usersPage(decoys(1)));
    });

    const user = await findSupabaseUserByEmail(target, { fetchImpl, pageSize: 2 });

    expect(user).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('throws when the page ceiling is reached before the table ends (absence unproven)', async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(usersPage(decoys(2))));

    await expect(findSupabaseUserByEmail(target, { fetchImpl, pageSize: 2, maxPages: 3 })).rejects.toThrow(
      /page ceiling was reached/,
    );
    expect(calls).toHaveLength(3);
  });

  it('throws on a failed page request instead of reporting absence', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ message: 'boom' }, 500));

    await expect(findSupabaseUserByEmail(target, { fetchImpl })).rejects.toThrow(/failed \(500\)/);
  });
});

describe('requireSupabaseUserByEmail', () => {
  it('throws loudly with the email and the pages searched when the user is missing', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(usersPage(decoys(1))));

    const error = await requireSupabaseUserByEmail(target, { fetchImpl, pageSize: 50 }).catch((e) => e);

    expect(error).toBeInstanceOf(SupabaseAdminLookupError);
    expect(error.message).toContain(target);
    expect(error.message).toContain('1 page(s)');
    expect(error.message).toContain('1 row(s) inspected');
  });

  it('returns the user when present', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(usersPage([target])));

    await expect(requireSupabaseUserByEmail(target, { fetchImpl })).resolves.toMatchObject({ id: `id-${target}` });
  });
});

describe('ensureSupabaseUser', () => {
  it('captures the id from the create response without searching', async () => {
    const { fetchImpl, calls } = stubFetch((_url, init) =>
      init?.method === 'POST' ? jsonResponse({ id: 'created-uuid', email: target }) : jsonResponse(usersPage([])),
    );

    const id = await ensureSupabaseUser(target, 'pw', 'Tester', { fetchImpl });

    expect(id).toBe('created-uuid');
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe('POST');
  });

  it('throws when the create response carries no id', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ email: target }));

    await expect(ensureSupabaseUser(target, 'pw', 'Tester', { fetchImpl })).rejects.toThrow(/carried no id/);
  });

  it('recovers an existing id via the paged lookup after a 409', async () => {
    const { fetchImpl } = stubFetch((url, init) => {
      if (init?.method === 'POST') return jsonResponse({ message: 'User already registered' }, 409);
      const page = Number(new URL(url).searchParams.get('page'));
      return page === 1 ? jsonResponse(usersPage(decoys(50))) : jsonResponse(usersPage([target]));
    });

    await expect(ensureSupabaseUser(target, 'pw', 'Tester', { fetchImpl, pageSize: 50 })).resolves.toBe(`id-${target}`);
  });

  it('throws loudly when a 409 cannot be resolved against the admin list', async () => {
    const { fetchImpl } = stubFetch((_url, init) =>
      init?.method === 'POST' ? jsonResponse({ message: 'User already registered' }, 409) : jsonResponse(usersPage(decoys(1))),
    );

    await expect(ensureSupabaseUser(target, 'pw', 'Tester', { fetchImpl })).rejects.toThrow(
      new RegExp(`no Supabase user exists for ${target}`),
    );
  });

  it('throws on a non-duplicate create failure', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ message: 'nope' }, 422));

    await expect(ensureSupabaseUser(target, 'pw', 'Tester', { fetchImpl })).rejects.toThrow(/create user failed \(422\)/);
  });
});

describe('deleteSupabaseUserByEmail', () => {
  it('deletes a user found beyond page 1', async () => {
    const { fetchImpl, calls } = stubFetch((url, init) => {
      if (init?.method === 'DELETE') return jsonResponse({});
      const page = Number(new URL(url).searchParams.get('page'));
      return page === 1 ? jsonResponse(usersPage(decoys(2))) : jsonResponse(usersPage([target]));
    });

    await expect(
      deleteSupabaseUserByEmail(target, { fetchImpl, pageSize: 2 }),
    ).resolves.toBe(true);

    const del = calls.find((c) => c.init?.method === 'DELETE');
    expect(del?.url).toBe(`${BASE}/auth/v1/admin/users/id-${target}`);
    expect(del?.init?.headers).toMatchObject({ apikey: KEY, Authorization: `Bearer ${KEY}` });
  });

  it('reports an absent user without deleting anything', async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(usersPage(decoys(1))));

    await expect(deleteSupabaseUserByEmail(target, { fetchImpl, pageSize: 50 })).resolves.toBe(false);
    expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(false);
  });
});
