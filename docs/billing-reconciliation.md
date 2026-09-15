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

## What it does about a problem

**Nothing.** It reports the problem and exits. It then fails, which is what sends the email.

It cannot cancel a subscription, change a plan, extend a trial, or lock a workspace. Every action it
takes - against Stripe and against the database - is a read. There is no code path in this check
that alters production data.

## When it emails you

1. Open the failed run using the link in the email.
2. Find `RESULT: DRIFT FOUND`. Above it, each problem lists the account email, what our record says,
   and what Stripe says.
3. Decide the fix:
   - **Stripe is right** (the common case): our record is stale. The next Stripe webhook for that
     account usually corrects it. If it does not, re-send the event from the Stripe dashboard.
   - **We granted something Stripe does not back**: confirm they really stopped paying. Ending the
     grant is a human decision; this check will not make it for you.
   - **A status we do not recognise**: a developer has to extend the status mapping before the check
     can judge it.
   - **Everything listed is operator-owned**: this is not a failure, it is a note. No action.
4. After fixing, re-run by hand: **Actions -> Billing reconciliation -> Run workflow**.

## Running it yourself

```
SUPABASE_DB_URL=... STRIPE_SECRET_KEY=... node scripts/billing-reconcile.mjs
```

Exit code `0` means the two lists agree. `1` means they do not. It prints the same report the
scheduled job emails you.

## If it fails saying CROSS_SERVICE_SECRET is not set

That is expected until someone adds the secret. It means the check found an account whose payment
stopped and wanted to ask the globe to lock that workspace - a step that is not wired up yet, and
that deliberately refuses to send anything until the globe's request format is confirmed. Add
`CROSS_SERVICE_SECRET` under **Settings -> Secrets and variables -> Actions** using the same value
the globe verifies with, then ask a developer to finish the integration point in
`scripts/lib/globe-tier-lock-sweep.mjs`.
