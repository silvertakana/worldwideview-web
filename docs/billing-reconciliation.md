# Billing reconciliation: the nightly check

## What it is, in one sentence

Once a day, an automated check compares two lists: who Stripe says is paying, and who our own
records say we have granted a plan to. If the lists disagree, the repository owner gets an email.

**That email is the entire alert.** There is no dashboard, no Slack message, and no pager. A red run
means one of three things: the two lists disagree, a payment that arrived never finished, or a queue
the check was able to read came back unreadable.

Green has two meanings. Usually the two lists agree **and both work queues below were read and were
empty**. Sometimes **the check could not read one of them at all**, because the table is not deployed
yet or an unfinished row carries no timestamp to judge it by. That run still exits `0`, but its last
line says `INCOMPLETE`, and exit code `0` does not email anyone, so nothing will tell you about it.
Read the exit-code table below before treating that as either a pass or an incident.

## The two lists

| | What it is | What it is trusted for |
|---|---|---|
| **Stripe** | The payment company. Cards, subscriptions, invoices. | Whether someone has actually paid, and until when. |
| **Our record** | A table in our database, `billing_subscriptions`. | What we granted this account: plan, price, status. |

Neither is "the truth" by itself. Stripe knows whether the money arrived. We know what we handed
over. The check works out, difference by difference, which of the two is the one to believe.

## And two queues that used to have no reader

Two earlier fixes made failure durable, and then nothing looked at it:

| The queue | What it holds | Why it matters |
|---|---|---|
| `billing_failures` rows nobody has resolved | A customer-facing step failed: either setting up their workspace, or telling the globe their plan | Someone may have paid and received nothing |
| `webhook_events` rows claimed and never finished | Stripe told us something happened, we started on it, and we never recorded finishing | The same problem, one step earlier |

The check reads both, prints what it found, and reports it. It does not repair them, and it writes to
neither table: closing a failure is a person's decision, and an automatic guess would take something
away from a customer who paid for it.

Three different things come out of that read, and they are worth keeping apart:

| What it found | What the run does |
|---|---|
| An unresolved `billing_failures` row | **Fails the run.** Stripe redelivering the event will not clear it. |
| A `webhook_events` row unfinished for **15 minutes or more** | **Fails the run.** |
| A queue that is not deployed, or one that is missing a column it needs | **Warns, and the run ends `INCOMPLETE`.** Exit code stays `0`. |
| A queue that exists but answers with something unreadable | **Fails the run.** Its query broke, which is a code or schema problem rather than a deploy. |

An unfinished event is only counted once it has gone **15 minutes** without an attempt, so a delivery
Stripe is still retrying is not reported as stuck: Stripe retries with backoff for days, so this is
"unfinished and making no progress", a signal to look at rather than a verdict that the event is lost.
An event claimed but never attempted at all has no age to measure, so it cannot be called stuck and
cannot be called fine: it is printed, and it makes the run `INCOMPLETE`.

### The migration this depends on, and what it really does

`webhook_events` grows `last_attempt_at` and `last_error`, and stops requiring `processed_at`, in
`supabase/migrations/20260915000001_webhook_events_completion_state.sql` (branch
`fix/billing-launch-hardening`).

An earlier version of this page said that a database without that migration fails the job with
`column "last_attempt_at" does not exist`. That is wrong, and the code is the reason. The check asks
the database's own catalogue which columns exist **before** it reads a row, and it never queries a
column it has established is absent. A missing migration is therefore a shape it recognises, not a
crash.

| The database it is pointed at | What happens |
|---|---|
| No `webhook_events` table at all | WARNING: its queue was not read. Run ends `INCOMPLETE`, exit code `0`. |
| Table present, no `last_attempt_at` column yet | No row can be aged, so no row can be called stuck. With nothing unfinished, nothing is reported. With unfinished rows, each is printed with a WARNING and the run ends `INCOMPLETE`, exit code `0`. |
| Table and column present, but a row holds `NULL` there | The same warning path for a different cause: a claim whose handler died before recording an attempt. No migration puts that stamp back. |
| Table present but with no `event_id`, or no `processed_at` | **FAILURE.** A shape the check does not know, which is not the same as an empty queue. |
| A catalogue query it cannot interpret | **FAILURE.** It cannot tell an empty queue from a missing table, and it will not report either as clean. |

So a pre-migration database produces neither a red job nor a quiet pass. It prints a warning, and the
last line of the run says `INCOMPLETE`. Until the migration lands, an unfinished webhook event cannot
be dated at all, so the run cannot tell you whether a payment is stuck. Read `INCOMPLETE` as "this
check could not finish its job": not as "there is a webhook backlog", and not as "all clear".

## What it checks

| The disagreement | What it means | Which side is right |
|---|---|---|
| A live Stripe subscription we have no record of | Someone is paying and we never wrote down what we gave them | Stripe |
| A record Stripe no longer backs | We granted something Stripe says is no longer being paid for | Our record (whether the grant ends is our call) |
| Statuses disagree | "Active" here, "past due" there | Stripe |
| Plan or price disagree | The record says one plan, Stripe says another | Stripe |
| Paid-through dates disagree | The record says a different end date | Stripe |
| A status we do not recognise | Stripe added something new we cannot interpret | Stripe (needs a developer) |

Rows an operator entered by hand are never compared. They are listed separately as
**operator-owned, not reconciled**, and the check will never propose changing one.

## What it does about a problem

It reports, and then it does at most two things.

1. **It fails**, which is what sends the email, when it found drift, a stuck payment, or a queue
   verdict that failed.
2. **If the disagreement is about payment stopping** - our record grants something Stripe no longer
   backs, or a status has lapsed - it asks the globe to run its own lock sweep. That is a single
   signed request with no payload at all. The globe then enforces the lock deadlines it has already
   armed on itself, from normal tier-sync traffic.

That second step sounds bigger than it is: the check does not decide who gets locked, does not name
any account, and cannot send a list, because the globe's endpoint takes no payload.

Everything else the check does is a read. It cannot cancel a subscription, change a plan, extend a
trial, or alter any production record.

## When it emails you

1. Open the failed run using the link in the email.
2. Find the last `RESULT:` line. Three different ones can be the reason you are reading this:
   - `RESULT: DRIFT FOUND (N)`: our record and Stripe disagree. Above it, each problem lists the
     account email, what our record says, and what Stripe says.
   - `RESULT: no drift between the ledger and Stripe, but the durable billing queues need
     attention (N)`: the two lists agree, but a payment that arrived did not finish, or a queue could
     not be read even though it exists. The `FAILURE:` lines above say which.
   - The third reason is **not** an email, because it does not fail the run:
     `RESULT: ... this run was INCOMPLETE ...`. You only find it by opening a scheduled run. It means
     something could not be read at all, and the `WARNING:` lines above say what. Usually that is a
     migration that has not been deployed. See the migration section above before treating it as an
     incident.
3. Read the detail lines the `FAILURE:` and `WARNING:` lines sit above. A flagged webhook event
   shows its Stripe event id, when we last touched it, and the last error. An unresolved failure
   shows the step that failed, the account, how many attempts, and when it was first seen.
4. Decide the fix:
   - **Drift, and Stripe is right** (the common case): our record is stale. The next Stripe webhook
     for that account usually corrects it. If it does not, re-send the event from the Stripe
     dashboard.
   - **Drift, and we granted something Stripe does not back**: confirm they really stopped paying.
     Ending the grant is a human decision; this check will not make it for you.
   - **Drift, a status we do not recognise**: a developer has to extend the status mapping before the
     check can judge it.
   - **Drift, and everything listed is operator-owned**: this is not a failure, it is a note. No
     action.
   - **An unresolved billing failure**: read the `error` on the row. Nothing closes these rows
     automatically at the moment: a failure is only cleared when something calls `resolveFailure()`
     in `src/lib/billing/records.ts`, and a row can easily describe a problem that has since fixed
     itself. So check the account's current state first. If it is now correct, the row is stale and a
     developer closes it; if it is not, fix the cause before closing anything.
   - **An unfinished webhook event**: re-send that event from the Stripe dashboard so we get another
     go at handling it. The event id in the row is the one to search for.
   - **`INCOMPLETE`**: nothing to fix in billing. Find what could not be read in the `WARNING:`
     lines, and check whether the migration above has been applied. A run that says `INCOMPLETE` says
     nothing either way about the queue it could not read.
5. After fixing, re-run by hand: **Actions -> Billing reconciliation -> Run workflow**.

## Running it yourself

```
SUPABASE_DB_URL=... STRIPE_SECRET_KEY=... CROSS_SERVICE_SECRET=... WWV_GLOBE_URL=... \
  node scripts/billing-reconcile.mjs
```

The exit code and the last line together are the whole verdict:

| Exit code | Last line | What it means |
|---|---|---|
| `0` | `RESULT: no drift. The ledger and Stripe agree.` | Everything was read and nothing was found. |
| `0` | `RESULT: ... this run was INCOMPLETE ...` | Nothing was found wrong in what could be read, and something could not be read. Not clean, and it does not email. |
| `1` | `RESULT: DRIFT FOUND (N)` | The two lists disagree. |
| `1` | `RESULT: ... the durable billing queues need attention (N)` | A queue verdict failed: a stuck payment, an unresolved failure, or a queue that exists but could not be read. |
| `1` | `FAILED: ...` | The check could not run at all: a missing setting, or a database or Stripe that would not answer. |

Exit code `0` on its own says only that the run did not fail. Of the two `0` rows above, exactly one
is a genuinely clean run: `RESULT: no drift. The ledger and Stripe agree.` The runner can print that
line only when both queues were **actually read**. Both ways of not reading one (a table that is not
deployed, a row that carries no timestamp to age) produce a warning, and any warning replaces it with
`RESULT: no drift, and no stuck payment found - but this run was INCOMPLETE (N warning(s) above). Do
not read it as a clean bill of health.` So `INCOMPLETE` at exit code `0` is not a quieter version of a
clean run; it is a different answer, and the `WARNING:` lines above it say what could not be read.

It prints the same report the scheduled job emails you.

## If it fails about a setting, or with a message you do not recognise

Each of these names the thing that is wrong and says what to do. None of them is a code bug.

| The message says | What it means |
|---|---|
| `SUPABASE_DB_URL is not set` | The check cannot read our record. Add the database connection string. |
| `STRIPE_SECRET_KEY is not set` | The check cannot read Stripe. Add the key. |
| `CROSS_SERVICE_SECRET is not set` | The check found an unpaid account and wanted to ask the globe for a lock sweep, but cannot sign the request. Add the secret under **Settings -> Secrets and variables -> Actions**, using the same value the globe verifies with. This is a **human step**, and until it is done every run that finds unpaid drift will fail here on purpose. |
| `WWV_GLOBE_URL is not set` | Same situation, but the globe's address is missing. The scheduled workflow supplies it; a manual run must pass it (for example `https://cloud-wwv.dev`). The script never guesses a URL. |
| `the globe still reports hasMore` | The globe had more armed deadlines than one run sweeps (500 per call, 3 calls). Nothing was dropped silently: this is a backlog to investigate on the globe. |
| `globe lock sweep reported failure: ...` | The globe answered, but its body says the sweep did not complete. **A partial sweep still answers HTTP 200**, so this body, not the status code, is the signal. The affected organization ids are in the globe's own server log. |
| `globe lock sweep reported failure: 2 of 4 due deadline(s) could not be applied` | The sweep ran and some deadlines could not be enforced. The counts in the message say how much of the backlog was actually swept. |
| `globe lock sweep reported unapplied as null instead of a number` | The globe's reply left out a count the check needs. An absent count is not a count of zero, so the run refuses to report a clean sweep rather than assuming one. |
| `globe lock sweep reported failed as "0" instead of a number` | The reply carried a count as text rather than as a number. The check does not convert it, because a count it cannot trust is not a count of zero either. |
| `globe lock sweep returned an empty body` | The sweep answered with nothing at all. A sweep the check cannot read is not a passing sweep. |
| `globe lock sweep returned a body that is not JSON` / `... a body that is not an object: an array` | The response was unreadable, or it was not the object the check needs. Same conclusion: not a passing sweep. |
| `<table> does not exist in this database, so its queue was NOT read` | A `WARNING`, not a failure. That queue is not deployed here, so the run ends `INCOMPLETE` with exit code `0`. See the migration section above. |
| `<table> exists but has no <column> column` | A `FAILURE`. The table is there but in a shape the check does not know, so it will not read it and call the result empty. |
| `webhook event <id> has been unfinished for ... past the 15m limit` | An event Stripe sent, that we claimed and never finished. Re-send it from the Stripe dashboard. |
| `billing_failures holds N unresolved failure(s)` | A customer-facing step failed and nobody has cleared it. Read the `error` on the row. |
