# Limits - what this evidence does NOT prove

Honest gaps, ordered by how much they could change a conclusion.

## 1. The hub route ran in-process, not on a live HTTP server

D1 imports the exported `POST` handler and calls it with a real `Request`. There is no listening port,
no Next.js request pipeline, no socket. The status returned is the status the handler produces, but a
full end-to-end HTTP request over the wire was not performed.

`docker-compose.test.yml` was not used. It exists only on `origin/main`, reuses the same container names
and the same host ports as the already-running dev stack (`wwv-dev-*`), and additionally requires an
external `npx supabase start`, a `GLOBE_DIR` checkout containing `Dockerfile.dev`, and stripe-mock.
Bringing it up would have required tearing down the running dev stack, so the in-process route handler
was chosen as the lighter method that still produces real observed output.

## 2. The Stripe surface is the single mocked thing in D1

`stripe.webhooks.constructEvent` and `stripe.checkout.sessions.retrieve` are replaced by test doubles.
The throw is injected, so the code path exercised is real, but a genuine Stripe failure (a real 5xx or
timeout) was not observed. `stripe-mock` (port 12111) was not started, so no real Stripe API surface was
used at all. Real Stripe signature verification did not run: the request carries a signature header that
the mocked verifier accepts.

## 3. The local Postgres needed one manual grant

`webhook_events` was created by the real migration with identical DDL. However, in the local rehearsal
database `service_role` held only `TRUNCATE`, `REFERENCES` and `TRIGGER`, because the migration was
applied outside Supabase's default-privilege setup. Supabase grants ALL on `public` tables to
`service_role` by default, so I granted `INSERT/SELECT/UPDATE/DELETE` to restore production fidelity.
This is the one place where the environment was adjusted rather than reproduced.

Note the silver lining: the first, un-adjusted run hit `permission denied for table webhook_events`, and
the route's fail-open path (`claimWebhookEvent` -> `"unknown"`) processed the event and answered 200
anyway. Both the claim-succeeds path and the claim-fails path end in a silent 200, but only the former
was verified against a Supabase-faithful grant.

## 4. Production was never touched

No ssh, no push, no production or staging access, per instruction. Nothing here proves the current state
of production data. Existing locked workspaces, existing burned `webhook_events` rows, and real
unfulfilled payments were NOT counted or sampled.

## 5. D2 used a fresh database, not production data

The `globe_bde_evidence` database was created inside the running local Supabase Postgres and migrated
with `prisma migrate deploy` (14 migrations applied). All fixtures were synthetic. Scale effects were not
tested: an organization with many owner-role members, or an owner holding many workspaces.

## 6. The hub's outbound call was not executed for D2

The hub's payload shape (`tier: "free"`, `status: "canceled"`) was read from `origin/main` source
(`route.ts:266-279`) and replayed into the globe route as a genuinely signed cross-service request. The
hub's own outbound `crossServiceFetch` to the globe was not performed in this environment, so the two
apps were never wired to each other over the network.

## 7. "No grace period" is a bounded negative

Evidence for it: the lock lands inside the same call, the reason string offers only a manual re-upgrade,
a workspace whose paid period end was 30 days in the future was locked anyway, and a grep of `src/` finds
no scheduled or time-based unlock. That is NOT exhaustive proof that no other subsystem ever unlocks a
workspace. I searched this repository only; a cron or ops action outside `worldwideview` was not looked for.

## 8. The proxy lockout was read, not executed

`src/proxy.ts:179-192` was read to establish what a locked workspace does to a user (403 for API calls,
redirect to `/locked` for pages). That middleware was not invoked and no 403 was observed. It also only
applies when `getEdition() === "cloud"` and the request carries a tenant subdomain.

## 9. The "deployed code" claim rests on branch refs, not on a deploy artifact

Both baselines are `origin/main` commits read from git. I did not verify that the running production
deployment actually corresponds to those commits, and the local checkouts are stale: the hub main
checkout is on `fix/nav-stale`, 26 commits behind, and its working tree has no `claimWebhookEvent` at
all, while the globe main checkout's `org-tier.ts` has no lock logic. All source was therefore read with
`git show origin/main:<path>`, and all execution happened in worktrees pinned to those exact commits.

## 10. Environment noise and leftover state

Every node/pnpm invocation emitted `Starting inspector on 127.0.0.1:9231 failed: address already in use`;
this is ambient and harmless, and it is present in the transcripts. Vite additionally warns that globe's
`vitest.config.ts` uses `__dirname` unsupported by `config-loader: native`. The D1 fixture row was
deliberately left in `webhook_events` as evidence. D2's fixture rows were left in `globe_bde_evidence` so
a re-run is reproducible; each run resets its own fixtures first. The unused throwaway Postgres container
(`bde-pg`) was removed. Both worktrees were confirmed clean after every run.
