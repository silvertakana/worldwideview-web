// @vitest-environment node
/**
 * D2 reproduction harness for worldwideview (globe) origin/main @ 41efdcde.
 *
 * Copied into the worktree as temp/billing-defense-evidence/d2-harness.test.ts
 * by d2-reproduce.ps1. The harness never modifies product source.
 *
 * Nothing is mocked. The harness drives the REAL setOrgTier() against the REAL
 * Prisma client against a real Postgres carrying the REAL prisma/migrations
 * files, and it also drives the REAL POST /api/service/tier-sync route handler
 * with a genuinely signed cross-service request.
 */
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.hoisted(() => {
  process.env.CROSS_SERVICE_SECRET = "test-cross-service-secret";
  // Force the isolated evidence database regardless of what a .env file loaded.
  if (process.env.D2_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.D2_DATABASE_URL;
  }
});

import { prisma } from "@/lib/db";
import { setOrgTier, TIER_RANK } from "@/lib/org-tier";
import { signCrossServiceRequest } from "@/lib/cross-service/sign";
import { POST as tierSyncPOST } from "@/app/api/service/tier-sync/route";

const OWNER_A = "d2-owner-a@repro.local";
const OWNER_B = "d2-owner-b@repro.local";
const PLAIN_MEMBER = "d2-member@repro.local";
const ORG_SLUG = "d2-repro-org";
const ORG_ID = "d2-org-0001";

const WS_A1 = "d2-ws-a1"; // owner A, first workspace, paid period still running
const WS_A2 = "d2-ws-a2"; // owner A, second workspace
const WS_B1 = "d2-ws-b1"; // the OTHER owner-role member's workspace
const WS_M1 = "d2-ws-m1"; // control: member (not owner) role
const ALL_WS = [WS_A1, WS_A2, WS_B1, WS_M1];

function say(line: string) {
  // eslint-disable-next-line no-console
  console.log(line);
}
function fmt(d: Date | null | undefined): string {
  return d ? d.toISOString() : "null";
}

async function cleanup() {
  const users = await prisma.betterAuthUser.findMany({
    where: { email: { in: [OWNER_A, OWNER_B, PLAIN_MEMBER] } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length > 0) {
    await prisma.workspaceMember.deleteMany({ where: { userId: { in: ids } } });
    await prisma.workspace.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.pluginMember.deleteMany({ where: { userId: { in: ids } } });
    await prisma.betterAuthUser.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.orgTier.deleteMany({ where: { organization: { slug: ORG_SLUG } } });
  await prisma.pluginOrganization.deleteMany({ where: { slug: ORG_SLUG } });
}

async function snapshot(label: string) {
  const rows = await prisma.workspace.findMany({
    where: { id: { in: ALL_WS } },
    select: { id: true, locked: true, lockedAt: true, lockedReason: true, trialEndsAt: true, tier: true },
    orderBy: { id: "asc" },
  });
  say(`[SNAPSHOT ${label}]`);
  for (const r of rows) {
    say(
      `  ${r.id} locked=${r.locked} lockedAt=${fmt(r.lockedAt)} tier=${r.tier} ` +
        `trialEndsAt=${fmt(r.trialEndsAt)} reason=${r.lockedReason === null ? "null" : JSON.stringify(r.lockedReason)}`,
    );
  }
  return rows;
}

describe("D2: globe locks every owner workspace immediately on a tier decrease", () => {
  it("flips locked/lockedAt/lockedReason inside one setOrgTier call, with no grace period", async () => {
    await cleanup();

    const db = await prisma.$queryRawUnsafe<Array<{ db: string }>>("select current_database() as db");
    say(`[SETUP] connected database = ${db[0]?.db}`);

    // ── Fixtures ───────────────────────────────────────────────────────
    const ownerA = await prisma.betterAuthUser.create({
      data: { id: "d2-user-owner-a", name: "D2 Owner A", email: OWNER_A },
    });
    const ownerB = await prisma.betterAuthUser.create({
      data: { id: "d2-user-owner-b", name: "D2 Owner B", email: OWNER_B },
    });
    const plain = await prisma.betterAuthUser.create({
      data: { id: "d2-user-plain", name: "D2 Plain Member", email: PLAIN_MEMBER },
    });
    const org = await prisma.pluginOrganization.create({
      data: { id: ORG_ID, name: "D2 Repro Org", slug: ORG_SLUG },
    });
    await prisma.pluginMember.createMany({
      data: [
        { id: "d2-member-owner-a", organizationId: org.id, userId: ownerA.id, role: "owner" },
        { id: "d2-member-owner-b", organizationId: org.id, userId: ownerB.id, role: "owner" },
        { id: "d2-member-plain", organizationId: org.id, userId: plain.id, role: "member" },
      ],
    });

    const paidPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await prisma.workspace.createMany({
      data: [
        { id: WS_A1, name: "D2 Owner A Workspace 1", subdomain: "d2-repro-a1", ownerId: ownerA.id, status: "active", plan: "pro", tier: "pro", trialEndsAt: paidPeriodEnd },
        { id: WS_A2, name: "D2 Owner A Workspace 2", subdomain: "d2-repro-a2", ownerId: ownerA.id, status: "active", plan: "pro", tier: "pro" },
        { id: WS_B1, name: "D2 Owner B Workspace", subdomain: "d2-repro-b1", ownerId: ownerB.id, status: "active", plan: "pro", tier: "pro" },
        { id: WS_M1, name: "D2 Plain Member Workspace", subdomain: "d2-repro-m1", ownerId: plain.id, status: "active", plan: "pro", tier: "pro" },
      ],
    });
    say(`[SETUP] paid period end declared on ${WS_A1} = ${paidPeriodEnd.toISOString()}`);
    say(
      `[EVIDENCE D2.mech] TIER_RANK pro=${TIER_RANK["pro"]} free=${TIER_RANK["free"]} -> a pro->free change is a rank decrease = ${
        TIER_RANK["free"] < TIER_RANK["pro"]
      }`,
    );

    // ── Establish the paid entitlement ─────────────────────────────────
    await setOrgTier(org.id, { tier: "pro", status: "active", trialEndsAt: null });
    const before = await snapshot("BEFORE CANCEL (org on pro/active)");
    say("");
    say(
      `[EVIDENCE D2.a] before: locked flags = ${JSON.stringify(before.map((r) => [r.id, r.locked]))}`,
    );
    expect(before.every((r) => r.locked === false), "no workspace is locked while the org is paid").toBe(true);

    // ── The cancellation: exactly what the hub sends on
    //    customer.subscription.deleted (plan "free", status "canceled") ──
    const t0 = new Date();
    await setOrgTier(org.id, { tier: "free", status: "canceled", trialEndsAt: null });
    const t1 = new Date();
    const after = await snapshot("AFTER CANCEL (org on free/canceled)");
    say("");
    say(`[EVIDENCE D2.b] setOrgTier called once, between ${t0.toISOString()} and ${t1.toISOString()}`);
    say(`[EVIDENCE D2.b] after: locked flags = ${JSON.stringify(after.map((r) => [r.id, r.locked]))}`);

    const byId = new Map(after.map((r) => [r.id, r]));
    const a1 = byId.get(WS_A1)!;
    const a2 = byId.get(WS_A2)!;
    const b1 = byId.get(WS_B1)!;
    const m1 = byId.get(WS_M1)!;

    say("");
    say(`[EVIDENCE D2.c] ${WS_A1} lockedAt=${fmt(a1.lockedAt)} inside the single call = ${
      !!a1.lockedAt && a1.lockedAt >= t0 && a1.lockedAt <= t1
    }`);
    say(`[EVIDENCE D2.c] ${WS_A1} reason = ${JSON.stringify(a1.lockedReason)}`);
    say(
      `[EVIDENCE D2.d] no grace period: ${WS_A1} still has a FUTURE paid period end (${fmt(
        a1.trialEndsAt,
      )}) yet was locked anyway = ${!!a1.trialEndsAt && a1.trialEndsAt > a1.lockedAt!}`,
    );
    say(
      `[EVIDENCE D2.e] blast radius: locked on every owner-role member's workspaces = ${JSON.stringify(
        [a1, a2, b1].map((r) => [r.id, r.locked]),
      )}; member-role control untouched = ${JSON.stringify([m1.id, m1.locked])}`,
    );

    // ── Independent readback straight from Postgres ────────────────────
    const raw = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `select id, locked, "lockedAt", "lockedReason" from workspaces where id like 'd2-ws-%' order by id`,
    );
    say("");
    say("[EVIDENCE D2.f] raw rows from Postgres after the single call:");
    for (const r of raw) say(`  ${JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? String(v) : v))}`);

    // ── Same defect through the REAL signed HTTP route ─────────────────
    await setOrgTier(org.id, { tier: "pro", status: "active", trialEndsAt: null });
    const beforeRoute = await snapshot("BEFORE ROUTE CALL (re-established pro/active)");
    const payload = { email: OWNER_A, tier: "free", status: "canceled" };
    const signed = signCrossServiceRequest({
      method: "POST",
      path: "/api/service/tier-sync",
      body: payload,
    });
    const res = await tierSyncPOST(
      new NextRequest("https://globe.local:3443/api/service/tier-sync", {
        method: "POST",
        headers: { "content-type": "application/json", ...signed },
        body: JSON.stringify(payload),
      }),
    );
    const resBody = await res.json();
    const afterRoute = await snapshot("AFTER ROUTE CALL");
    say("");
    say(
      `[EVIDENCE D2.g] POST /api/service/tier-sync {tier:free,status:canceled} -> HTTP ${res.status} ${JSON.stringify(resBody)}`,
    );
    say(
      `[EVIDENCE D2.g] locked before = ${JSON.stringify(beforeRoute.map((r) => [r.id, r.locked]))}, locked after = ${JSON.stringify(
        afterRoute.map((r) => [r.id, r.locked]),
      )}`,
    );
    say("");

    // ── Assertions: each asserts the defect ───────────────────────────
    expect(a1.locked, "owner A workspace 1 locked by the downgrade").toBe(true);
    expect(a2.locked, "owner A workspace 2 locked by the same call").toBe(true);
    expect(b1.locked, "the other owner-role member's workspace locked too").toBe(true);
    expect(m1.locked, "a member-role (non-owner) workspace is left alone").toBe(false);
    expect(a1.lockedAt).toBeTruthy();
    expect(a2.lockedAt).toBeTruthy();
    expect(b1.lockedAt).toBeTruthy();
    expect(m1.lockedAt, "the control workspace gets no lock timestamp").toBeNull();
    expect(
      a1.lockedAt!.getTime() >= t0.getTime() && a1.lockedAt!.getTime() <= t1.getTime(),
      "the lock timestamp falls inside the single setOrgTier call",
    ).toBe(true);
    expect(a1.lockedReason).toBe(
      "Tier downgraded from pro (active) to free (canceled). Re-upgrade to restore access.",
    );
    expect(a2.lockedReason).toBe(a1.lockedReason);
    expect(b1.lockedReason).toBe(a1.lockedReason);
    expect(m1.lockedReason).toBeNull();
    expect(
      a1.trialEndsAt!.getTime() > a1.lockedAt!.getTime(),
      "locked while the paid period was still in the future: no deferral to period end",
    ).toBe(true);
    expect(
      a1.lockedReason!.includes("Re-upgrade"),
      "the only remedy offered is a manual re-upgrade; nothing schedules the unlock",
    ).toBe(true);

    expect(res.status, "the real signed tier-sync route accepts free/canceled").toBe(200);
    expect(afterRoute.find((r) => r.id === WS_A1)!.locked, "the route locks immediately too").toBe(true);
  }, 120000);
});
