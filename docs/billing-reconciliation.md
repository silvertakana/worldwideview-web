# Billing reconciliation: the nightly check

## What it is, in one sentence

Once a day, an automated check compares two lists: who Stripe says is paying, and who our own
records say we have granted a plan to. If the lists disagree, the repository owner gets an email.

**That email is the entire alert.** There is no dashboard, no Slack message, and no pager. A green
run means the two lists agree. A red run means they do not, and the email is the only signal.

## The two lists

| | What it is | What it is trusted for |
|---|---|---|
| **Stripe** | The payment company. Cards, subscriptions, invoices. | Whether someone has actually paid, and until when. |
| **Our record** | A table in our database, `billing_subscriptions`. | What we granted this account: plan, price, status. |

Neither is "the truth" by itself. Stripe knows whether the money arrived. We know what we handed
over. The check works out, difference by difference, which of the two is the one to believe.

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

## The two queues it also reads

Comparing the two lists catches a record that drifted. It cannot catch a payment that arrived and
then went nowhere, because a payment that never finished writing its record is missing from *both*
lists. Two tables hold those rows, and the check now reads them:

| The table | What a row in it means |
|---|---|
| `webhook_events` | Stripe told us something, we started handling it, and we never finished. |
| `billing_failures` | Something we had to do after taking the money - hand over the plan, or sync the tier - failed in a way a Stripe retry cannot fix. |

A payment that has been unfinished for more than 15 minutes, or any entry in `billing_failures`
that nobody has resolved, fails the run and emails you. The check reports these rows and never
clears one: deciding that a failed handover is safe to forget is a person's call, and a nightly job
that guessed would take something away from a customer who paid for it.

**If a table does not exist yet**, the check cannot read it at all. That is a different thing from it
being empty, so the run says `NOT DEPLOYED` and warns that the durable record is not deployed here,
and it tells you the run is `INCOMPLETE` rather than clean. It does not fail, because a missing table
is a missing migration rather than a billing incident - but it never reports agreement it did not
establish.

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
2. Find the `RESULT:` line.
   - **`RESULT: DRIFT FOUND`**: the two lists disagree. Each problem above it lists the account
     email, what our record says, and what Stripe says.
   - **`RESULT: no drift between the ledger and Stripe, but the durable billing queues need
     attention`**: the two lists agree, but a payment is stuck. Look at the `durable queues FAILURE:`
     lines. They name no account: a stuck event is named by its Stripe event id and an outstanding
     failure by its stage, which is what a developer needs to find the row.
   - **`RESULT: no drift, and no stuck payment found - but this run was INCOMPLETE`**: nothing is red
     and there is nothing to fix tonight. Read the `durable queues WARNING:` lines, which usually
     mean a table's migration has not been applied yet.
3. Decide the fix:
   - **Stripe is right** (the common case): our record is stale. The next Stripe webhook for that
     account usually corrects it. If it does not, re-send the event from the Stripe dashboard.
   - **We granted something Stripe does not back**: confirm they really stopped paying. Ending the
     grant is a human decision; this check will not make it for you.
   - **A status we do not recognise**: a developer has to extend the status mapping before the check
     can judge it.
   - **Everything listed is operator-owned**: this is not a failure, it is a note. No action.
   - **A stuck payment, or an unresolved failure**: Stripe retrying the event will not clear these.
     A developer has to look at the row and decide whether to finish the handover or abandon it.
4. After fixing, re-run by hand: **Actions -> Billing reconciliation -> Run workflow**.

## Running it yourself

```
SUPABASE_DB_URL=... STRIPE_SECRET_KEY=... CROSS_SERVICE_SECRET=... WWV_GLOBE_URL=... \
  node scripts/billing-reconcile.mjs
```

Exit code `0` means the two lists agree and no payment has been left half-finished. `1` means either
the lists disagree or something is stuck. It prints the same report the scheduled job emails you.

## If it fails about a missing setting

Each of these names the setting and says what to do. None of them is a code bug.

| The message says | What it means |
|---|---|
| `SUPABASE_DB_URL is not set` | The check cannot read our record. Add the database connection string. |
| `STRIPE_SECRET_KEY is not set` | The check cannot read Stripe. Add the key. |
| `CROSS_SERVICE_SECRET is not set` | The check found an unpaid account and wanted to ask the globe for a lock sweep, but cannot sign the request. Add the secret under **Settings -> Secrets and variables -> Actions**, using the same value the globe verifies with. This is a **human step**, and until it is done every run that finds unpaid drift will fail here on purpose. |
| `WWV_GLOBE_URL is not set` | Same situation, but the globe's address is missing. The scheduled workflow supplies it; a manual run must pass it (for example `https://cloud-wwv.dev`). The script never guesses a URL. |
| `the globe still reports hasMore` | The globe had more armed deadlines than one run sweeps (500 per call, 3 calls). Nothing was dropped silently: this is a backlog to investigate on the globe. |
