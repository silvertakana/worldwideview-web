# ADR-0010: The hub image ships without a package or process manager, and merges deploy by webhook

- **Status:** Accepted
- **Date:** 2026-09-26
- **Repositories:** `worldwideview-web` (hub, this repo), with configuration held in GitHub (a repo webhook) and Coolify (the `worldwideview web` application)
- **Numbering:** the WorldWideView ecosystem numbers ADRs continuously across repositories. This
  continues the sequence after [ADR-0009](adr-0009-payment-only-access.md).

## Context

Three facts met in the same place.

**The image gate had been red since 2026-09-16, and it was right.** `Docker Publish` runs the
shared Trivy step with `severity: CRITICAL,HIGH` and `exit-code: 1`, and a later step fails the
job when that scan finds anything. It found 15 things; the 9 that gated the build all lived in
tooling baked into the runner stage, and **none** in the application's own dependency tree (the
only finding under `app/node_modules/` was a medium):

| Path | Findings |
|---|---|
| `usr/local/lib/node_modules/npm/node_modules/…` | pacote (2), brace-expansion (3), ip-address, picomatch, sigstore |
| `usr/local/lib/node_modules/pm2/node_modules/js-yaml` | js-yaml 4.3.1 |

Because that step fails the job, everything behind it was skipped on every push: the SBOM, the
Cosign signature, the provenance attestation, the smoke test, and the deploy trigger.

**pm2 could not be patched out of the problem.** `pm2@latest` (7.0.4) pins `js-yaml` to exactly
`4.3.1`; the advisory's fix (4.3.2) is published but out of range, so no version bump reaches it.
An allowlist entry was the only alternative to removing it.

**Nothing needed the four processes anyway.** Four sites described running four pm2 workers, and
every one of them described a *cost absorbed* rather than a capability used:

| Site | The cost it documented |
|---|---|
| `src/lib/alerts/notify.ts` | alert de-duplication lives in process memory, so the ceiling is one send per worker per window - up to four where one is described |
| `src/app/admin/billing/actions.ts` | the kill-switch cache is invalidated only in the process that served the request: "instant" meant "within 10 seconds" |
| `supabase/migrations/20260915120001_create_billing_subscriptions.sql` | `UNIQUE(email)` exists because two deliveries "routinely land on different processes with no shared memory between them" |
| `AGENTS.md` | documented the deployment as four workers |

Independently, the Coolify application is limited to **1 GB** of memory while the image permits
each process a **768 MB** heap. Four processes in a 1 GB box is not headroom: exceeding it kills
the container and all four with it, which is the one failure a process manager inside the
container cannot prevent.

**And merges never deployed.** Two independent defects. The deploy step is the last step of the
job, so the failing gate skipped it. It would have done nothing anyway: it exits 0 when
`secrets.COOLIFY_API_TOKEN` is unset - a secret that exists in neither repository - and its
request body names no application. The globe repo has a push webhook aimed at Coolify and the hub
repo had none, which is exactly why the globe deployed itself and the hub did not.

## Decision

1. **The runtime image carries no package manager and no process manager.** The runner stage
   deletes the npm CLI the base image ships, along with its bundled dependency tree, and the app
   starts as `node server.js`. This is how Next.js documents running a `standalone` build; four
   processes inside one container was the unusual part.
2. **The vulnerability gate keeps its severity and its fail step.** No allowlist, no
   `.trivyignore`, no threshold change: the image is fixed rather than the gate weakened.
3. **Deploys arrive by webhook, not from CI.** A push webhook on the repository points at the
   Coolify application, matching the globe's arrangement. The CI deploy step is left in place and
   unused.
4. **The documentation follows the runtime.** The comments and the `AGENTS.md` bullet above now
   describe a single process, and state what changes if the hub is ever scaled to several
   containers. The applied migration's comment is left untouched: it is a historical record, its
   constraint remains correct, and it becomes accurate again under replication.

## Consequences

**Easier**

- The image gate passes with no exceptions, so the SBOM, signature, provenance attestation and
  smoke test run on every push again.
- Every documented multi-process cost improves: identical alerts are collapsed exactly once per
  window instead of up to four times, and the billing kill switch takes effect on the next
  request instead of within ten seconds.
- Memory is coherent: one process with a 768 MB ceiling inside a 1 GB container.
- A merge to `main` deploys itself, so shipping a fix is a merge rather than a merge plus a
  manual command.
- `UNIQUE(email)` becomes belt-and-braces rather than the only thing preventing duplicate rows.

**Harder / accepted trade-offs**

- **Crash recovery moves to the platform.** Coolify restarts a container whose application has
  exited - its restart limit defaults to 10, it emits a `container_restarted` notification, and
  it stops and notifies at `restart_limit_reached`. The difference is that a restart is now a
  container restart: in-flight requests are lost rather than picked up by a surviving process.
  That is the trade accepted for a smaller image and one source of concurrency truth.
- **Throughput is one process.** The hub is a landing page, an account area and a billing engine,
  so this is not a capacity decision anyone will notice; if capacity is ever needed the lever is
  more containers, which also brings rolling deploys. Scaling that way reopens the alert
  de-duplication gap, which `notify.ts` states in place.
- **No package manager inside the container.** An operator cannot install anything inside the
  running image. That is deliberate: it is also what removes the image's largest cluster of
  advisories.

## Amendment (2026-09-26): the gate measures every severity, not just the two it names

The Context above says the scan "found 15 things; the 9 that gated the build". The count of
gating findings was wrong, and the error was in the gate's favour.

`aquasecurity/trivy-action` unsets `TRIVY_SEVERITY` unless `limit-severities-for-sarif` is `true`
(`entrypoint.sh`), and the shared workflow leaves that input unset. The scan therefore runs at
every severity while `exit-code: 1` still fails the step, so `severity: CRITICAL,HIGH` limits only
what the uploaded SARIF keeps. Every finding gates, and a single medium is enough.

That is why deleting pm2 and the npm CLI was necessary but not sufficient. It closed 40 of the
dashboard's 41 Trivy alerts (13 high, 17 medium, 10 low) and left exactly one:
`CVE-2026-45819` in `baseline-browser-mapping@2.10.37` (fixed in 2.11.0), reached through both
`next` (`^2.9.19`) and `browserslist` (`^2.10.12`).

Decision 2 is unchanged: no allowlist, no `.trivyignore`, no threshold change. The image is fixed
rather than the gate weakened, so `package.json` carries a `pnpm` override that raises the package
to a patched release for every parent that pulls it in.
