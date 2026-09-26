# Group A evidence - honest limits

Same style as `../defense/LIMITS.md`. Everything here is a
bounded negative: something this run does not prove or did not exercise. It is listed so a
reviewer does not have to guess which parts are inference and which are observation.

## Coverage

1. **Stripe's server is a stand-in.** The real `stripe-node` SDK is used - real retry policy,
   real error mapping, real HTTP client - but the requests go to a local HTTP server that speaks
   Stripe's wire format, not to `api.stripe.com` or `stripe-mock`. The two failure modes injected
   are a 400-level `invalid_request_error` (immediate) and the same after a 2500 ms stall. Real
   Stripe outage modes (timeouts, 500s, connection resets) were **not** exercised, so
   stripe-node's own retry behaviour under those conditions is not covered.
2. **The globe is a stand-in.** `/api/provision` and `/api/service/tier-sync` are a local HTTP
   counter that returns chosen statuses. The real globe (its Prisma org model, its idempotency
   claim, the actual "already exists returns ok" contract, and the `tier-fallback` path the hub
   comments rely on) was **not** started and not verified. Every "downstream work happened"
   claim means "an HTTP request reached the stand-in", nothing more.
3. **No browser, no Caddy, no full stack.** `docker-compose.test.yml` was **not** used. It
   reuses the running dev stack's container names and host ports (3000/3001/3002/5000/80/443/
   5432/6379), needs `GLOBE_DIR` to contain `Dockerfile.dev`, needs `Caddyfile.dev` and `certs/`,
   and needs the marketplace and data-engine images built. Bringing it up would have taken down
   the user's running dev stack. The hub was therefore run directly (`next dev --webpack`) on a
   spare port. Consequence: the Playwright billing suite (`pnpm test:e2e`) and the cookie-domain
   / TLS / Caddy parts of the real pipeline are outside this evidence.
4. **`src/proxy.ts` ran, but only its pass-through path.** Requests to
   `127.0.0.1:3011/api/billing/webhook` went through the Next middleware, which builds a
   Supabase server client and refreshes claims. The tenant-subdomain lockout branch
   (`src/proxy.ts` lockout logic, `getEdition() === 'cloud'` + tenant host) was not exercised -
   no `Host` header was crafted for it.
5. **Only the event types the scenarios need.** `checkout.session.completed`,
   `customer.subscription.deleted` (fixture present) and the signature paths were driven.
   `invoice.payment_failed`, `customer.subscription.created/updated` and the shipped
   `test/simulator` matrix were **not** run against the live endpoint in this evidence run;
   they are covered by the repo's own unit suite, which is not independent evidence.
6. **The other Groups (B, C, D) were not touched.** Groups A only. D2 (tier decrease locks the
   workspace), D5 (vocabulary), D6 (401 reason leak), D7 (globe tier read), D9 (marketplace
   billing), D10 (E2E money path) remain exactly as the decision doc left them.

## Environment mutations this run made

7. **The rehearsal database was migrated.** `20260915140000_webhook_events_completion_state.sql`
   was applied to `supabase_db_worldwideview-web.billing-rehearsal` / `postgres` / `public.webhook_events`.
   It was at the pre-fix shape before, and it is at the fix shape now. For the falsification step
   the `processed_at` DEFAULT and NOT NULL were reverted, the pre-fix run was taken, and the
   migration was re-applied - the transcript records both transitions and the final verification.
8. **Group A fixture rows were deliberately left behind.** `webhook_events` rows with the
   `evt_groupa_%` prefix (7 of them in the final state) are kept as the durable record of this
   run. The harness deletes only rows with that prefix, before each run.
9. **`next dev` appends an agent-rules block to `AGENTS.md`.** Next 16 writes an
   `<!-- BEGIN:nextjs-agent-rules -->` section into the project-root `AGENTS.md` at startup, so
   the evidence worktree shows `AGENTS.md` modified. That is Next's own behaviour, not an edit of
   the product source. Nothing under `src/`, `supabase/`, or `test/` was modified.
10. **Two extra worktrees exist.** `worldwideview-web.billing-group-a-evidence` (the harness) and
    `worldwideview-web.billing-group-a-baseline` (pre-fix `origin/main`, created for the
    falsification). Both are removable with `git worktree remove`; the orchestrator recreates the
    baseline one on demand. The team's own
    `worldwideview-web.fix-billing-launch-hardening` worktree was read only and is untouched.
11. **node_modules is shared by junction.** Both new worktrees junction `node_modules` onto the
    fix worktree's copy. The only `package.json` difference between `origin/main` and the fix tip
    is one line (the version string), so the dependency tree is the same; the transcript records
    that diff. This is why the hub is started with `next dev --webpack` - Turbopack rejects a
    node_modules junction that points outside the project root.

## Timing and stability

12. **A2.d and A2.e are timing-sensitive by construction.** A2.d holds the handler open for
    2500 ms and polls the ledger until the claim row appears; A2.e relies on one delivery
    stalling inside a 2500 ms Stripe call while a sibling completes in between. Both have wide
    margins (the claim was first observed at 139 ms of a 2586 ms delivery) and both assert their
    own preconditions, but they are not timing-independent: on a heavily loaded machine the
    margins could invert. An earlier revision of A2.d that sampled the ledger once at +500 ms
    did flake once under load; it was replaced with the polling form.
13. **The A2.1 concurrency count is timing-dependent.** "5 of 5 deliveries were allowed to
    process" is a function of how many deliveries are in flight at the same instant. The stable
    facts are the ones asserted: exactly one ledger row, no 5xx, and (as the contrast shows) more
    than one delivery permitted to process post-fix where pre-fix permitted exactly one.
14. **`NODE_OPTIONS=--inspect=127.0.0.1:9231` noise** appears in child-process stderr as
    `Starting inspector ... address already in use`. It is ambient and cosmetic; it does not
    affect exit codes or results.

## Claims deliberately NOT made

15. **Production was never touched.** No live Stripe key, no deployed endpoint, no Coolify host.
    The Stripe key in the harness is `sk_test_group_a_local` and the endpoint under test is a
    `next dev` process on loopback.
16. **"Deployed code" rests on a commit, not on a deployment.** The fix side is
    `0ffd7033187755f982425717fca5e2e25315f25e`, the tip of `fix/billing-launch-hardening` at the
    time of this run. Nothing here proves that commit is what is running anywhere.
17. **No reconciliation mechanism was tested** because none exists. The partial index
    `webhook_events_unfinished_idx (last_attempt_at) WHERE processed_at IS NULL` created by the
    migration is not read by any code in the repository; it is groundwork for the D3 reconciler.
    A claim whose process is killed between claim and completion - and which never fails once -
    leaves an unfinished row with `last_attempt_at = NULL`, so the index's own sort key is NULL
    for the freshest abandoned work. Nothing sweeps it. It recovers only because Stripe retries,
    which stops after Stripe's own retry window lapses.
18. **The launch gates were not re-verified.** `NEXT_PUBLIC_BILLING_ENABLED=false`, the disabled
    Stripe webhook endpoint, and the `sk_test_` key are taken from
    `billing-launch-branch-status.md` section 6, which is read-only context. This run is about
    handler behaviour, not about whether billing is reachable in production.
19. **Nothing here is a fix.** Group A was reproduced and measured; A4, A5, A6 and Finding A2.1
    are open. No product source was changed.
