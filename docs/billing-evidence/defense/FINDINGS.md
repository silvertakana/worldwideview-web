# Billing defense evidence - findings

Both defects are REAL on deployed code. Every claim below is backed by captured output in
`D1-TRANSCRIPT.txt` and `D2-TRANSCRIPT.txt`; the few things read rather than executed are labelled.

| | Defect 1: hub silent payment loss | Defect 2: globe instant lockout |
|---|---|---|
| Repo | `worldwideview-web` | `worldwideview` |
| Baseline (origin/main) | `8d881c4890fce4af094e98a0a60918df50700d6a` | `41efdcde0294a1870e0bd9e4c2c9eebb297bac0f` |
| Verdict | **CONFIRMED** | **CONFIRMED** |
| Driven through | `POST /api/billing/webhook` handler, in-process | `setOrgTier()` and the real signed `POST /api/service/tier-sync` |
| Real plumbing | real PostgREST + Postgres + real migration DDL + real `claimWebhookEvent` | real Prisma + real Postgres + 14 real `prisma/migrations` files |
| Raw evidence, one line | HTTP status **200** (no locked flag applies) | `locked` **false -> true** |

## Defect 1 - the ledger records the claim as completion

- Delivery 1, which throws inside the switch: HTTP **200** `{"received":true}`
- `webhook_events` row exists, `processed_at` already set:
  `evt_d1_repro_silent_payment_loss_0001 | 2026-09-15 04:44:44.506902+00`
- Byte-identical redelivery: HTTP **200** `{"received":true,"duplicate":true}`
- Downstream globe calls after **both** deliveries: **0** (provisioning 0, tier-sync 0)
- Rows in `webhook_events` for that event: **1**

Mechanism, from the baseline source:

1. `route.ts:146` claims `event.id` via `claimWebhookEvent()` **before** the switch runs.
2. `webhook_events.processed_at TIMESTAMPTZ NOT NULL DEFAULT now()` means the claim row is born
   already looking processed. The table has exactly three columns (`id`, `event_id`, `processed_at`);
   no status, outcome, attempts or fulfilled column exists anywhere in the schema.
3. The switch has exactly one catch (`route.ts:318-320`) doing `console.error(...)`, and `route.ts:322`
   returns 200 unconditionally.

Consequence: a user can complete checkout, the work can fail, and the system permanently records the
event as processed. Stripe never retries because the hub answered 200, and a manual redelivery is
turned into a no-op by the burned claim. Nothing records that the payment was never fulfilled.

The shipped suite enshrines this and passes green (34 tests passed):

- `route.test.ts:325` `it("still returns 200 received:true when a Stripe outbound call throws")`
  asserts `expect(res.status).toBe(200)`.
- `route.test.ts:47-49` mocks `claimWebhookEvent`, so the suite never touches `webhook_events` and
  cannot observe the burned claim.

## Defect 2 - locked on the same call, with no grace period

One `setOrgTier(org, {tier:"free", status:"canceled"})` after `pro/active`:

- `d2-ws-a1` (owner A) `locked false -> true`, `lockedAt` set inside the call
- `d2-ws-a2` (owner A, second workspace) `locked false -> true`
- `d2-ws-b1` (the other owner-role member) `locked false -> true`
- `d2-ws-m1` (member role, control) `locked false`, unchanged
- reason: `Tier downgraded from pro (active) to free (canceled). Re-upgrade to restore access.`
- the same outcome through the real signed route: `POST /api/service/tier-sync
  {tier:"free",status:"canceled"}` -> HTTP **200**, `d2-ws-a1` locked immediately

Mechanism, from the baseline source:

1. `org-tier.ts:68-73` maps a canceled status to `free` (rank 0) and computes
   `isDowngrade = newRank < previousRank`. Any decrease, for any reason, is a downgrade.
2. `org-tier.ts:80-92` writes `locked: isDowngrade`, `lockedReason`, `lockedAt: new Date()` across
   `where: { ownerId: { in: ownerIds } }` - every workspace owned by **any** member whose role is `owner`.
3. No grace period, no deferral. Observed: `d2-ws-a1` had a paid period end 30 days in the future and
   was locked anyway. Nothing in `src/` schedules an unlock; the only writers of `locked: false` are the
   not-a-downgrade branch, i.e. another tier change.

What the user gets, read from `src/proxy.ts:179-192` (read from source, not executed): an API call
returns `403 {"error":"Workspace locked","reason":...}`, a page request redirects to `/locked?reason=...`.

The shipped globe suite enshrines the lock and passes green (19 tests passed):
`org-tier.test.ts:110` `it("locks workspace on downgrade from pro to free")` asserts
`locked: true`, `lockedReason: expect.stringContaining("Tier downgraded from pro")`, `lockedAt: expect.any(Date)`.

## Additional observations (out of scope, not reproduced)

- `setOrgTier` never updates `workspaces.tier`: `tier` stayed `pro` on every locked row.
- The same downgrade-lock code is duplicated in `src/app/api/instance/[id]/tier/route.ts:36-40`.
- `webhook_events` is written as `service_role`. In the local rehearsal database that role held only
  TRUNCATE/REFERENCES/TRIGGER, so my first run hit `permission denied for table webhook_events`, and the
  fail-open path processed the event and answered 200 anyway. Both paths end in a silent 200.

## Deliverables and how to reproduce

All under `temp\billing-defense-evidence\`:

| File | What it is |
|---|---|
| `d1-reproduce.ps1` | D1 orchestrator; re-runnable end to end |
| `d2-reproduce.ps1` | D2 orchestrator; re-runnable end to end |
| `d1-harness.test.ts`, `d2-harness.test.ts` | the vitest harnesses the orchestrators copy in and delete |
| `D1-TRANSCRIPT.txt`, `D2-TRANSCRIPT.txt` | captured runs (209 and 260 lines) |
| `LIMITS.md` | honest gaps |

Worktrees: `worldwideview-web.billing-defense-evidence` (8d881c4) and
`worldwideview.billing-defense-evidence` (41efdcde). Postgres for D2:
database `globe_bde_evidence` in container `supabase_db_worldwideview-web.billing-rehearsal`.
