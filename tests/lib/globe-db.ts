/* eslint-disable no-console */
import { Pool } from 'pg';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';

/**
 * Raw-SQL access to the GLOBE database (worldwideview / public schema).
 *
 * The billing E2E suite asserts on globe-side state (better-auth user, org
 * membership, org_tiers, workspaces) and seeds a globe user + org so the
 * tier-sync has something to flip. When this suite lived in the globe repo it
 * used the globe's generated Prisma client; the hub repo has no Prisma (it is
 * Supabase-based), so these helpers talk to the same Postgres directly.
 *
 * Table names are the globe Prisma @@map values: user, account, session,
 * organization, member, org_tiers, workspaces. Columns keep their camelCase
 * Prisma field names (no field-level @map in the globe schema).
 *
 * GLOBE-SPECIFIC DEPENDENCY: this class requires the globe's Postgres to be
 * reachable at DATABASE_URL (defaults to the dev stack's
 * postgresql://postgres:postgres@127.0.0.1:5432/worldwideview). The docker
 * test stack provides it via the `db` service (DATABASE_URL=...@db:5432/...).
 */
export const DEFAULT_GLOBE_DB_URL =
  'postgresql://postgres:postgres@127.0.0.1:5432/worldwideview?schema=public';

/**
 * better-auth credential password hash, byte-compatible with
 * @better-auth/utils/password@0.4.2 (used by the globe's Better Auth stack):
 *   salt = 16 random bytes as hex; key = scrypt(password.normalize("NFKC"),
 *   salt, 64, {N: 16384, r: 16, p: 1}); stored as `${salt}:${keyHex}`.
 * The seeded globe account is never logged into by this suite (login happens
 * on the hub via Supabase), but a real hash keeps the seed authentic.
 */
export function hashBetterAuthPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password.normalize('NFKC'), salt, 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 128 * 16384 * 16 * 2,
  });
  return `${salt}:${key.toString('hex')}`;
}

export interface GlobeUserRow {
  id: string;
  email: string;
}

export interface GlobeOrgMembershipRow {
  organizationId: string;
  role: string;
}

export interface OrgTierRow {
  tier: string;
  status: string;
}

export interface WorkspaceRow {
  id: string;
  locked: boolean;
  lockedAt: Date | null;
  lockedReason: string | null;
}

export class GlobeDb {
  private pool: Pool;

  constructor(connectionString?: string) {
    this.pool = new Pool({
      connectionString:
        connectionString || process.env.DATABASE_URL || DEFAULT_GLOBE_DB_URL,
    });
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async findUserByEmail(email: string): Promise<GlobeUserRow | null> {
    const res = await this.pool.query<GlobeUserRow>(
      'SELECT id, email FROM "user" WHERE email = $1 LIMIT 1',
      [email],
    );
    return res.rows[0] ?? null;
  }

  /** First org membership for a user — mirrors pluginMember.findFirst. */
  async findMembershipForUser(userId: string): Promise<GlobeOrgMembershipRow | null> {
    const res = await this.pool.query<GlobeOrgMembershipRow>(
      'SELECT "organizationId", role FROM "member" WHERE "userId" = $1 LIMIT 1',
      [userId],
    );
    return res.rows[0] ?? null;
  }

  async getOrgTier(organizationId: string): Promise<OrgTierRow | null> {
    const res = await this.pool.query<OrgTierRow>(
      'SELECT tier, status FROM "org_tiers" WHERE "organizationId" = $1 LIMIT 1',
      [organizationId],
    );
    return res.rows[0] ?? null;
  }

  async findWorkspaceByOwner(ownerId: string): Promise<WorkspaceRow | null> {
    const res = await this.pool.query<WorkspaceRow>(
      'SELECT id, locked, "lockedAt", "lockedReason" FROM "workspaces" WHERE "ownerId" = $1 LIMIT 1',
      [ownerId],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Seed a globe user + org + workspace + free tier for the billing flow,
   * mirroring the Prisma-based seeding this suite used in the globe repo.
   * Returns the seeded user id. Call purgeTestUser() first for repeat runs.
   */
  async seedTestUser(opts: {
    email: string;
    password: string;
    name?: string;
    orgName?: string;
    orgSlug?: string;
    workspaceName?: string;
    workspaceSubdomain?: string;
  }): Promise<string> {
    const { email, password } = opts;
    const name = opts.name ?? 'Billing E2E Tester';
    const orgName = opts.orgName ?? 'Billing E2E Org';
    const orgSlug = opts.orgSlug ?? 'billing-e2e-org';
    const workspaceName = opts.workspaceName ?? 'Billing E2E Workspace';
    const workspaceSubdomain = opts.workspaceSubdomain ?? 'billing-e2e-ws';

    const userId = randomUUID();
    const orgId = randomUUID();
    const now = new Date();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, true, 'ADMIN', $4, $4)`,
        [userId, name, email, now],
      );
      await client.query(
        `INSERT INTO "account" (id, "userId", "accountId", "providerId", password, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, 'credential', $4, $5, $5)`,
        [randomUUID(), userId, email, hashBetterAuthPassword(password), now],
      );
      await client.query(
        `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, $4)`,
        [orgId, orgName, orgSlug, now],
      );
      // role MUST be "owner" — the globe's setOrgTier() only locks workspaces
      // owned by org members with role "owner".
      await client.query(
        `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
         VALUES ($1, $2, $3, 'owner', $4)`,
        [randomUUID(), orgId, userId, now],
      );
      await client.query(
        `INSERT INTO "workspaces" (id, name, subdomain, "ownerId", status, plan, tier, locked, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 'trialing', 'basic', 'free', false, $5, $5)`,
        [randomUUID(), workspaceName, workspaceSubdomain, userId, now],
      );
      await client.query(
        `INSERT INTO "org_tiers" (id, "organizationId", tier, status, "createdAt", "updatedAt")
         VALUES ($1, $2, 'free', 'active', $3, $3)`,
        [randomUUID(), orgId, now],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    console.log(`[globe-db] seeded user ${email}, org ${orgId.slice(0, 8)}, workspace, org_tier=free`);
    return userId;
  }

  /** Remove every globe row for a user (FK-safe order, mirrors the old teardown). */
  async purgeTestUser(email: string): Promise<void> {
    const user = await this.findUserByEmail(email);
    if (!user) return;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM "workspaces" WHERE "ownerId" = $1', [user.id]);
      const memberships = await client.query<{ organizationId: string }>(
        'SELECT "organizationId" FROM "member" WHERE "userId" = $1',
        [user.id],
      );
      for (const m of memberships.rows) {
        await client.query('DELETE FROM "org_tiers" WHERE "organizationId" = $1', [m.organizationId]);
        await client.query('DELETE FROM "member" WHERE "organizationId" = $1', [m.organizationId]);
        await client.query('DELETE FROM "organization" WHERE id = $1', [m.organizationId]);
      }
      await client.query('DELETE FROM "session" WHERE "userId" = $1', [user.id]);
      await client.query('DELETE FROM "account" WHERE "userId" = $1', [user.id]);
      await client.query('DELETE FROM "user" WHERE id = $1', [user.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    console.log(`[globe-db] purged globe rows for ${email}`);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
