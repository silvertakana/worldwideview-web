# Billing reconciliation: the nightly check

## What it is, in one sentence

Once a day, an automated check compares two lists: who Stripe says is paying, and who our own
records say we have granted a plan to. If the lists disagree, the repository owner gets an email.

**That email is the entire alert.** There is no dashboard, no Slack message, and no pager. A green
run means the two lists agree **and both work queues below are empty**. A red run means one of those
is not true, and the email is the only signal.

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

The check now reads both, prints them, and **fails the run if either is non-empty**. It reports them;
it does not repair them.

An unfinished event is only counted once it has gone an hour without an attempt, so a delivery Stripe
is still retrying is not reported as stuck. An event that was claimed but never attempted at all
cannot be judged either way, so it is not counted: the ledger records an attempt time, not a claim
time, so those rows have no age to measure.

### A dependency you should know about

The unfinished-events check reads a `webhook_events` column, `last_attempt_at`, that is added by a
migration still living on another branch:

`supabase/migrations/20260915000001_webhook_events_completion_state.sql` (branch
`fix/billing-launch-hardening`).

Until that migration is applied, the query fails with `column "last_attempt_at" does not exist` and
the run fails. That is deliberate. The alternative, quietly skipping a check we cannot run, would
print a clean report about work we never did. **So until that migration lands, expect this job to be
red**, and read the failure as "this check could not run", not as "there is a webhook backlog".

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

It reports, and then it does exactly one thing.

1. **It fails**, which is what sends the email.
2. **If the disagreement is about payment stopping** - our record grants something Stripe no longer
   backs, or a status has lapsed - it asks the globe to run its own lock sweep. That is a single
   signed request with no payload at all. The globe then enforces the lock deadlines it has already
   armed on itself, from normal tier-sync traffic.

That second step is worth being precise about, because it sounds bigger than it is. The check does
not decide who gets locked, does not name any account, and does not send a list. It cannot: the
globe's endpoint takes no payload. The check's only power is to make the globe look at its own
books.

Everything else the check does is a read. It cannot cancel a subscription, change a plan, extend a
trial, or alter any production record.

## When it emails you

1. Open the failed run using the link in the email.
2. Find the `RESULT:` lines. There is one per kind of problem, and more than one can appear:
   - `RESULT: DRIFT FOUND`: our record and Stripe disagree. Above it, each problem lists the account
     email, what our record says, and what Stripe says.
   - `RESULT: ... UNRESOLVED BILLING FAILURE(S)`: above it, each one shows the step that failed, the
     account, how many times we tried, and when it was first seen.
   - `RESULT: ... UNFINISHED WEBHOOK EVENT(S)`: above it, each one shows Stripe's event id, when we
     last touched it, and the last error.
3. Decide the fix:
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
4. After fixing, re-run by hand: **Actions -> Billing reconciliation -> Run workflow**.

## Running it yourself

```
SUPABASE_DB_URL=... STRIPE_SECRET_KEY=... CROSS_SERVICE_SECRET=... WWV_GLOBE_URL=... \
  node scripts/billing-reconcile.mjs
```

Exit code `0` means the two lists agree and both work queues are empty. `1` means at least one of
those is not true. It prints the same report the scheduled job emails you.

A red run for a reason other than drift means the check could not finish, not that it found something:
a database the check cannot read, or a queue whose columns do not exist yet, both fail the run rather
than reporting a clean result. A report that says "0" only means something if the check was able to
read the thing it counted.

## If it fails about a missing setting

Each of these names the setting and says what to do. None of them is a code bug.

| The message says | What it means |
|---|---|
| `SUPABASE_DB_URL is not set` | The check cannot read our record. Add the database connection string. |
| `STRIPE_SECRET_KEY is not set` | The check cannot read Stripe. Add the key. |
| `CROSS_SERVICE_SECRET is not set` | The check found an unpaid account and wanted to ask the globe for a lock sweep, but cannot sign the request. Add the secret under **Settings -> Secrets and variables -> Actions**, using the same value the globe verifies with. This is a **human step**, and until it is done every run that finds unpaid drift will fail here on purpose. |
| `WWV_GLOBE_URL is not set` | Same situation, but the globe's address is missing. The scheduled workflow supplies it; a manual run must pass it (for example `https://cloud-wwv.dev`). The script never guesses a URL. |
| `the globe still reports hasMore` | The globe had more armed deadlines than one run sweeps (500 per call, 3 calls). Nothing was dropped silently: this is a backlog to investigate on the globe. |
| `the globe lock sweep did not complete: success=false` | The globe answered, but its body says some due organizations were not enforced. **A partial sweep still answers HTTP 200**, so this body - not the status code - is the signal. The affected organization ids are in the globe's own server log. |
| `globe lock sweep returned an empty body` / `not JSON` | The sweep answered with something unreadable. A sweep we cannot read is not a passing sweep, so the run fails. |
| `column "last_attempt_at" does not exist` | The unfinished-events check cannot run against a database that predates the D1 migration. See the dependency note above. Not a code bug. |
| `relation "public.billing_failures" does not exist` | Same idea for the failure queue: the table is missing, so the check refuses to report "0 failures". |
