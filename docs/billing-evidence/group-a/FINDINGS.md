# Group A (money safety) - reproduced evidence

**Scope.** Every Group A break-it scenario from `temp\billing-launch-readiness.md`
section 2, reproduced from nothing against the running local billing test stack.

**Code under test.** Evidence worktree `worldwideview-web.billing-group-a-evidence`,
branch `billing-group-a-evidence`, HEAD `0ffd7033187755f982425717fca5e2e25315f25e`
(= the tip of `fix/billing-launch-hardening`, the D1 fix). The team's own worktree at
`worldwideview-web.fix-billing-launch-hardening` was **not touched**; it was read
only and left clean at the same commit.

**Companion artifact.** `GROUPA-TRANSCRIPT.txt` (43 KB) is the full run: quoted source, the
ledger pre/post state, every `[EVIDENCE]` line, every `[CHECK]`, and the pre-fix falsification.

---

## Result at a glance

| Row | Scenario | Verdict |
|---|---|---|
| A1 | payment confirmed, never delivered | **FIXED and verified end to end** |
| A2 | the same payment twice | Ledger atomicity verified. **Exactly-once processing does NOT hold - see Finding A2.1** |
| A3 | forged signature | **Verified** - hard 400, distinguishable, ledger untouched, zero downstream work |
| A4 | payment ok, workspace creation fails | **STILL OPEN** - 200 + fully-completed row, no durable trace of the partial fulfilment |
| A5 | tier sync before the workspace exists | **STILL OPEN** - one retry (~528 ms) then a silent give-up, no durable trace |
| A6 | no account link | **STILL OPEN** - log-only, no durable remediation record |

Harness: **53 checks, 53 pass, 0 fail** on the fix. Same file on pre-fix `origin/main`: **8 A1
assertions fail, A3 stays green.**

---

## How this was driven (and what is real)

Not an in-process import of `POST()`. The driver starts the hub as a real server
(`next dev --webpack` on `127.0.0.1:3011`) and POSTs real bytes over a real socket:

| Layer | Real | Stood in for |
|---|---|---|
| Transport / routing | TCP socket, full Next.js route pipeline incl. `src/proxy.ts` | - |
| Stripe signature | the hub's own `stripe.webhooks.constructEvent`; the driver HMAC-SHA256-signs in Stripe's exact `t=<ts>,v1=<sig>` format and re-verifies every body with the real Stripe SDK before sending | - |
| Stripe outbound HTTP | the real `stripe-node` SDK (real retry policy, real error mapping) | `api.stripe.com` -> a local HTTP server |
| Ledger | `@supabase/supabase-js` -> PostgREST -> Postgres, the real migration DDL | - |
| Cross-service signing | real `src/lib/cross-service/sign.ts` HMAC; the stand-in globe records the headers it receives | the globe's `/api/provision` and `/api/service/tier-sync` |

The two stand-ins are ordinary HTTP servers, so "did the handler do downstream work" is
answered by observed network traffic rather than by a spy.

**Ledger environment.** Container `supabase_db_worldwideview-web.billing-rehearsal`, database
`postgres`, table `public.webhook_events`, reached through Kong/PostgREST at
`http://127.0.0.1:54321`. Migration
`supabase/migrations/20260915000001_webhook_events_completion_state.sql` was applied to it by
the orchestrator (it was at the pre-fix shape, `processed_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
before this work). All Group A fixture rows use the `evt_groupa_%` prefix and are enumerated in
the transcript's post-state section.

---

## A1 - payment confirmed, never delivered

A mid-handler failure was injected with the real stripe-node SDK pointed at a stand-in Stripe
that answers the outbound `checkout.sessions.retrieve` with a 400-level API error.

```
delivery 1  ->  HTTP 500  {"received":false,"error":"Webhook handling failed"}
ledger row  ->  processed_at = NULL, last_error = "GROUP A INJECTED STRIPE OUTAGE",
                last_attempt_at = 2026-09-15T05:19:08.44+00:00
downstream globe calls during the failed delivery = 0

REDELIVERY (byte-identical body)  ->  HTTP 200  {"received":true}
downstream globe calls            ->  POST /api/provision, POST /api/service/tier-sync
ledger row                        ->  processed_at = 2026-09-15T05:19:08.544+00:00, last_error = NULL

THIRD delivery (genuine replay)   ->  HTTP 200  {"received":true,"duplicate":true}
downstream globe calls added      ->  0
```

The three properties that make the money safe all hold, and each is observed rather than
inferred: the failure **is returned to Stripe** (500, not 200), a **durable unfinished record
exists** with the reason and the time, and the retry **actually reprocesses** instead of being
absorbed as a duplicate. The ledger never gains a second row.

On pre-fix `origin/main` the same three deliveries produce: `200 {"received":true}` on the
failure, a row whose `processed_at` is already stamped by the claim, a redelivery answered
`200 {"received":true,"duplicate":true}`, and **zero** downstream calls. That is the silent
payment loss D1 describes, reproduced.

## A2 - the same payment twice

**Sequential replay.** First delivery `200 {"received":true}` with 2 downstream calls. A
byte-identical second delivery: `200 {"received":true,"duplicate":true}`, **0** stripe-node
requests, **0** downstream calls, still exactly one ledger row.

**Claim-before-work ordering.** With the handler held open for 2586 ms, the claim row first
became visible **139 ms** in - `processed_at = NULL`, one downstream call already issued - and
`processed_at` was set only when the delivery completed. The durable record provably precedes
the work it protects.

**Atomicity across concurrent deliveries.** 5 simultaneous deliveries of one event create
**exactly one** ledger row and all answer 200. The ledger claim itself is atomic.

**The failing sibling cannot un-complete a completed row.** Delivery X is stranded inside the
Stripe call and fails 2500 ms later; delivery Y starts 500 ms in, is accepted, and completes the
same event. X then answers `500` - and the row is byte-identical before and after: same
`processed_at` (`2026-09-15T05:19:13.417+00:00`), `last_error` still `NULL`, one row. The
`UPDATE ... WHERE processed_at IS NULL` guard in `failWebhookEvent` does what its comment claims.

### Finding A2.1 (NEW, open): the fix trades silent loss for duplicate processing

`A2.c` fires 5 concurrent deliveries of one event and counts how many were allowed to do the
work. Measured on both revisions with the same harness:

| | ledger rows | deliveries allowed to process |
|---|---|---|
| pre-fix `origin/main` | 1 | **1** |
| post-fix `0ffd703` | 1 | **5** |

Pre-fix, a duplicate that arrived while the first delivery was still in flight lost the
`INSERT ... ON CONFLICT DO NOTHING` and was turned away as a duplicate (the hub logged
`Duplicate event ... already processed; skipping`). Post-fix, one row is still created
atomically, but every concurrent delivery reads `processed_at IS NULL` and is therefore allowed
to process - which is exactly the behaviour the unfinished state is designed for.

**Money impact observed: none.** The ledger keeps one row, and `/api/provision` and
`/api/service/tier-sync` are idempotent set operations. **Residual risk:** N concurrent
deliveries fan out into N provisioning and N tier-sync calls, so a Stripe retry storm is
amplified at the globe, where the hub has no rate limiting and no error reporting.

This is a property change the fix introduces, not something the decision doc asked for. It is
worth a decision: accept at-least-once (and say so), or narrow the window (for example, treat a
claim younger than some threshold as in-flight and absorb the duplicate).

## A3 - forged signature

```
tampered signature        ->  HTTP 400  text/plain;charset=UTF-8
                             "Webhook Error: No signatures found matching the expected signature for payload..."
missing signature header  ->  HTTP 400  "Webhook Error: No stripe-signature header value was provided."
webhook_events rows created for the forged event = 0
downstream globe calls during the forgery         = 0
stripe-node requests during the forgery           = 0
```

The 400 is distinguishable from a transport failure and from the 500 handler-failure path, it
claims nothing in the ledger, and it produces no downstream work. Identical on pre-fix code -
this is the control showing the falsification run is specific to the money path.

**Response hygiene.** Both 400 bodies and both 200 bodies were scanned: no secret, no
service-role key, no stack frame, no internal path, no database internals. The 400 does echo
Stripe's own SDK message verbatim, including its "are you passing the raw request body"
guidance - that is third-party text, not hub internals, and matches standard Stripe practice.

## A4 - payment ok, workspace creation fails (still open)

```
/api/provision answered 500 -> webhook answers 200 {"received":true}
/api/provision attempts = 1, /api/service/tier-sync attempts = 1
ledger row -> processed_at set, last_error = NULL
```

The paid user is left un-provisioned while the ledger records the event as fully completed. The
only trace is one error-level log line. The ledger cannot distinguish a fully-provisioned payment
from a partially-fulfilled one; there is no column for it and no row. This is D8's blast radius
and it is unchanged by the fix.

## A5 - tier sync before the workspace exists (still open)

```
tier-sync answered 404 to every attempt
attempts = 2, gap between attempt 1 and 2 = 528 ms
webhook -> 200 {"received":true}
ledger row -> processed_at set, last_error = NULL, last_attempt_at = NULL
```

Exactly one retry, ~528 ms, then a silent give-up. The paid user's globe workspace stays at free
tier and nothing durable records it - `last_error` and `last_attempt_at` stay NULL, so the new
columns do not capture this failure class.

## A6 - no account link (still open)

```
checkout session carries neither metadata.userId nor client_reference_id
/api/provision attempts = 0   (provisioning is skipped entirely)
/api/service/tier-sync attempts = 1
webhook -> 200 {"received":true}
ledger row -> processed_at set, last_error = NULL
```

The skip is logged loudly with `sessionId`, `email`, `customerId` and `eventId`, which is good
operator ergonomics - but it is log-only. Nothing durable names the affected account, so the
remediation trail dies with the log retention window.

---

## Falsification: the harness is not vacuous

A green harness that is also green on broken code proves nothing. Section 7 of the orchestrator
reverts `webhook_events.processed_at` to its pre-fix shape (`NOT NULL DEFAULT now()`), runs the
**identical harness file** against a worktree of `origin/main` (`8d881c4`), and requires it to
fail:

```
pre-fix run: 23 checks, 8 failed (all A1), exit 1
  FAIL A1: a mid-handler failure answers 500, not 200            :: status=200
  FAIL A1: the 500 body states the failure without leaking       :: {"received":true}
  FAIL A1: the row is UNFINISHED (processed_at IS NULL)          :: processed_at set by the claim
  FAIL A1: the row records the failure reason durably            :: last_error=null
  FAIL A1: the row records when the attempt failed               :: last_attempt_at=null
  FAIL A1: the retry response is the plain success shape         :: {"received":true,"duplicate":true}
  FAIL A1: the retry actually REPROCESSED - provisioning         :: provision hits=0
  FAIL A1: the retry actually REPROCESSED - the tier was synced  :: tier-sync hits=0
A3 on the same pre-fix run: all checks PASS (the control)
```

The ledger shape is then restored and verified.

---

## Reproduce

```powershell
pwsh -File docs/billing-evidence/group-a/groupa-reproduce.ps1
```

Prerequisites: the local Supabase billing stack running
(`supabase_db_worldwideview-web.billing-rehearsal` + Kong on `127.0.0.1:54321`), Docker, Node,
and the evidence worktree. Ports used: 3011/30191/30192 (fix side), 3013/30193/30194 (pre-fix
side). The script creates the pre-fix worktree if it is missing and needs no Stripe account, no
network, and no browser. It writes `GROUPA-TRANSCRIPT.txt` and exits non-zero on any failure.

## Artifacts

| File | What it is |
|---|---|
| `GROUPA-TRANSCRIPT.txt` | the full run (43 KB): source quotes, ledger state, evidence, checks, falsification |
| `_orchestrator.log` | raw console capture of the same run |
| `\worldwideview-web.billing-group-a-evidence\temp\billing-group-a-evidence\groupa-harness.mjs` | the self-contained driver (real HTTP, real ledger, stand-in Stripe + globe) |
| `...\groupa-reproduce.ps1` | the orchestrator (environment, migration, run, falsification, transcript) |
| `...\_hub-dev.log` | the hub dev server log for the fix-side run |
| `...\baseline\_hub-dev.log` | the hub dev server log for the pre-fix run |
