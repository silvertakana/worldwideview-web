# ADR-0009: Paying is the only way in; the access-code system is disabled, not deleted

- **Status:** Accepted
- **Date:** 2026-09-20
- **Repositories:** `worldwideview-web` (hub, this repo), `worldwideview` (globe)
- **Numbering:** the WorldWideView ecosystem numbers ADRs continuously across repositories.
  The globe holds adr-0001 to adr-0008 (adr-0008 is cross-service linking and HMAC), so the
  hub's first ADR continues the sequence at 0009 rather than restarting at 0001.

## Context

Access to a cloud workspace used to have two doors:

1. **Pay.** Stripe checkout, a `billing_subscriptions` row written by the webhook, a
   tier pushed to the globe.
2. **Redeem a code.** An invite code from `access_codes` redeemed at `/accounts/redeem`,
   which wrote a `user_entitlements` row.

The real purchase path is now live, so the second door is no longer wanted as a
customer-facing path: it is a leftover from the beta, it competes with pricing, and it
confuses people who have already paid.

The prompt for this decision was a concrete defect, not tidiness. The gate on the
create-instance route asked only the code store:

```
src/app/api/provisioning/instance/route.ts -> hasInstanceEntitlement() -> user_entitlements
```

Measured against production on 2026-09-20:

| Store | Rows | Reading |
|---|---|---|
| `billing_subscriptions` | 2 (one `pro`/`active` with a real price id, one `free`/`canceled`) | one live payer |
| `user_entitlements` | 17 (13 active: 12 `beta_tester` from codes, 1 `pro` `manual_verify`) | all code-derived |
| `access_codes` | 36 (18 used, 18 unused, 21 revoked) | 35 `beta_tester`, 1 `early_access` |
| `billing_overrides` | 0 | no operator grants yet |
| overlap between the paying account and any entitlement holder | **0** | — |

So the one account that had actually paid was refused a workspace (403), shown a
redeem-code button on the instances page, and had `free` written to the globe mirror when
it tried. The payment path itself was healthy (19/19 webhook events processed, 0 failures,
0 paused billing): the gate simply never looked at it.

## Decision

**Payment is the only customer-facing way in. The code system keeps working but is hidden.**

Specifically:

1. **One access authority.** `src/lib/billing/cloud-access.ts` is the single answer to "may
   this account have a workspace, and at what tier". Both provisioning routes ask it:
   `POST /api/provisioning/instance` and `POST /api/provisioning/workspace`. It reads three
   durable stores and takes the highest tier found:

   | Order | Store | Written by |
   |---|---|---|
   | 1 | `billing_subscriptions` (live statuses only) | the Stripe webhook, or an operator's manual row |
   | 2 | `billing_overrides` | `/admin/overrides` (audited) |
   | 3 | `user_entitlements` (redeemed codes) | `/accounts/redeem` |

   On a tie the earlier row wins, so a deliberate operator grant outranks a subscription
   at the same tier. Each store is read in its own try/catch: one broken store must not
   hide a grant held in another, and access is refused only when no store produces a grant
   at all (fail closed).

2. **One refusal, pointing at pricing.** `No active plan. Choose a plan at /pricing to
   create your workspace.` The customer-facing surfaces now say this and offer **View
   plans**; no code affordance is shown anywhere a normal customer can reach.

3. **The code system stays alive and reachable.** Not deleted, not migrated away, not
   expired. `/accounts/redeem` still redeems, `access_codes` and `user_entitlements` still
   hold their 36 and 17 rows, and the admin screens still issue codes. What changed is
   discoverability: the hub's "Redeem Code" menu item (sidebar, mobile nav, header) is
   gone, and the instances page no longer offers a code button. The legacy `/redeem` alias
   still redirects to `/accounts/redeem`.

4. **The globe's dead endpoint is removed.** `worldwideview`'s `/api/access-code` endpoint
   predates this and was consumed by nothing, so it is deleted along with its public-path
   entry. That is the only part of the code system that is actually removed, and no code
   path calls it.

5. **Two gates, not one.** `POST /api/provisioning/workspace` also mints a globe
   organization and a setup token, and had no gate at all. It now asks the same authority.
   The Stripe webhook is deliberately unaffected: it calls `provisionWorkspace()` directly,
   because a webhook has no session cookie and must be able to provision for a customer
   who has just paid.

## Consequences

**Easier**

- A paying customer gets in. The tier the authority returns is converted to a tier the
  globe can actually hold (`toGlobeTier`) before it is sent, so a legacy hub-only tier
  cannot produce a globe 400.
- There is one place to answer the access question, and it is testable without a database:
  `cloud-access.test.ts` pins the policy (which store wins, what a refusal is, what an
  unlimited limit is) against stubbed stores.
- A broken store degrades instead of denying: the payer is let in even if the entitlement
  read throws.

**Harder / accepted trade-offs**

- **Legacy code holders are now invisible to us.** 12 accounts hold an active
  `beta_tester` entitlement from a code and will keep working indefinitely: nothing expires
  them, and this decision deliberately did not add an expiry rule, because adding one would
  cut all 12 off at once. If they are ever to end, that is a separate decision with a
  migration plan.
- **`beta_tester` and `early_access` are not globe tiers.** The globe accepts
  `free|pro|team|enterprise` only. For a code holder the authority reuses whatever tier the
  globe already has, and falls back to `free` (with a warning in the log) when the globe
  cannot be read. A code holder therefore keeps the access they have rather than gaining a
  tier, which is the conservative direction.
- **The one-shot "already used" stamp no longer gates creation.** A successful create still
  writes `user_entitlements.used_at` (it is the audit trail, and `/api/auth/entitlement`
  still reports it), but the instances page no longer refuses a creation because of it. The
  instance limit is now the only rule, so a `beta_tester` code holder with no workspace may
  create one even if an earlier entitlement was stamped used. That is more permissive than
  the old behaviour, never less, which is the direction a drain path should err in.
- **Two sources of truth for "who is paying" still exist.** The billing page renders its
  plan badge from `tier-fallback.ts`, which reads live Stripe and then the code store; it
  does not read `billing_subscriptions`. The authority reads the durable ledger instead,
  because the fallback makes a live Stripe API call per request and ignores the record the
  webhook already wrote. When Stripe is unreachable the two can disagree for a paying
  customer (see Known gaps).
- **The refusal message is now duplicated as a literal in two route test suites.** It is
  pinned against the real module in `cloud-access.test.ts`, so a copy change fails there
  rather than silently passing.

## Operating it

**To give someone access by hand**, in order of preference:

1. **A real payment** - `/pricing`. This is the intended path and needs no operator.
2. **An audited override** - `/admin/overrides`. Use this for a locked-out paying customer.
   It records who granted what and why, and it is the only path that also pushes the tier to
   the globe immediately. See `docs/operator-manual-billing-override.md`.
3. **A code**, when the grant must be a hub-only tier (`beta_tester`, `early_access`) that
   the override screen deliberately refuses to grant. Issue it at **Admin Dashboard ->
   Access codes** and send the customer the link (`/accounts/redeem`); they cannot find it
   on their own any more.

**To revive codes as a customer-facing path**, if short-term invite codes are wanted again:
put the menu item back (the redeem page, form, server action and tables were all left
untouched), or hand out the `/accounts/redeem` link directly. No schema or endpoint work is
required, and the authority already treats a redeemed code as access.

## Verification

The authority's policy is covered by `src/lib/billing/cloud-access.test.ts` (subscription
wins over nothing, override outranks a subscription, legacy code still grants, canceled and
suspended do not, a broken store never becomes a grant, `free` means an instance limit of
0, unlimited paid tiers stay unlimited). The routes are covered by their own suites, and
`tests/billing-provisioning-create.spec.ts` drives the paid path end to end with a
`billing_subscriptions` row and zero entitlements (Test 7), alongside the code-seeded tests
that guarantee the drain path keeps working.

## Known gaps

- **The billing page badge can still read Free for a paying customer when Stripe is
  unreachable**, because `tier-fallback.ts` does not consult `billing_subscriptions`. The
  access decision is fixed; this display path is not. It is only observable when the Stripe
  API call fails.
- **`src/lib/supabase/admin.ts` imports `server-only`, which is not a declared dependency.**
  Next.js aliases it at build time, but Vitest resolves from `node_modules`, so any suite
  that reaches that module without mocking it fails at collection. Existing suites mock the
  admin client for this reason.
