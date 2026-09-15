import { createAdminClient } from "@/lib/supabase/admin";
import type {
  BillingFailure,
  BillingFailureInput,
  FailureStage,
  StripeSubscriptionInput,
  SubscriptionWriteResult,
} from "@/lib/billing/billing-tables";
import { FAILURE_COLUMNS, asMessage } from "@/lib/billing/billing-tables";

/**
 * Writes to the durable billing record: the failure log and the Stripe-driven
 * subscription writes. Reads and manual operator records live in
 * subscription-store.ts; the shared row types live in billing-tables.ts.
 *
 * ROW SEMANTICS: one row per customer (see subscription-store.ts). A Stripe
 * resubscribe updates the existing row rather than adding a second one.
 */

/**
 * Records a business failure that a Stripe retry will not fix, counting attempts
 * on the same unresolved (event_id, stage) instead of inserting duplicates.
 *
 * Returns false when the failure could not be recorded. That is deliberately not
 * a throw: the caller is inside a webhook catch block, and this return value is
 * the only signal it gets that even the recording failed.
 */
export async function recordFailure(input: BillingFailureInput): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    const admin = createAdminClient();
    const existing = await findUnresolvedFailure(input.eventId ?? null, input.stage);

    if (existing) {
      const { error } = await admin
        .from("billing_failures")
        .update({ attempts: existing.attempts + 1, last_attempt_at: now, error: input.error ?? null })
        .eq("id", existing.id);
      return !error;
    }

    const { error } = await admin.from("billing_failures").insert({
      user_id: input.userId ?? null,
      email: input.email ?? null,
      event_id: input.eventId ?? null,
      event_type: input.eventType ?? null,
      stage: input.stage,
      error: input.error ?? null,
      attempts: 1,
      first_seen_at: now,
      last_attempt_at: now,
    });
    return !error;
  } catch (err) {
    console.error(`[billing] recordFailure failed for stage ${input.stage}: ${asMessage(err)}`);
    return false;
  }
}

async function findUnresolvedFailure(
  eventId: string | null,
  stage: FailureStage,
): Promise<{ id: string; attempts: number } | null> {
  const query = createAdminClient()
    .from("billing_failures")
    .select("id, attempts")
    .eq("stage", stage)
    .is("resolved_at", null);
  const { data } = await (eventId === null ? query.is("event_id", null) : query.eq("event_id", eventId)).maybeSingle();
  return (data as { id: string; attempts: number } | null) ?? null;
}

/** Everything still unresolved, oldest first - the operator's work queue. */
export async function listUnresolvedFailures(): Promise<BillingFailure[]> {
  const { data, error } = await createAdminClient()
    .from("billing_failures")
    .select(FAILURE_COLUMNS)
    .is("resolved_at", null)
    .order("first_seen_at", { ascending: true });
  if (error) throw new Error(`[billing] listUnresolvedFailures failed: ${error.message}`);
  return (data as BillingFailure[] | null) ?? [];
}

export async function resolveFailure(failureId: string): Promise<boolean> {
  const { error } = await createAdminClient()
    .from("billing_failures")
    .update({ resolved_at: new Date().toISOString() })
    .eq("id", failureId);
  if (error) throw new Error(`[billing] resolveFailure failed: ${error.message}`);
  return true;
}

/* ───────────────────────── subscription writes ───────────────────────── */

type ExistingRow = { id: string; source: string; updated_at: string };

/** Postgres SQLSTATE for a unique-constraint violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Why there is no `.upsert()` here: the unique index that lets a manual row
 * carry no stripe_subscription_id is PARTIAL (WHERE stripe_subscription_id IS
 * NOT NULL), and PostgREST resolves an onConflict target to the index name,
 * which fails with 42P10 against a partial index. Hence an explicit
 * read-then-insert-or-update; the two unique indexes still prevent a duplicate
 * live row, and the insert-loser path below handles losing that race.
 */
async function findSubscriptionRow(email: string, stripeSubscriptionId: string | null): Promise<ExistingRow | null> {
  const admin = createAdminClient();
  const columns = "id, source, updated_at";
  if (stripeSubscriptionId) {
    const { data } = await admin
      .from("billing_subscriptions")
      .select(columns)
      .eq("stripe_subscription_id", stripeSubscriptionId)
      .maybeSingle();
    if (data) return data as ExistingRow;
  }
  const { data } = await admin.from("billing_subscriptions").select(columns).eq("email", email).maybeSingle();
  return (data as ExistingRow | null) ?? null;
}

/**
 * Records the subscription a Stripe event describes.
 *
 * Two guards, because "the newest event wins" is not always right:
 *
 *  - A row with source = 'manual' is never written over. An operator grant is a
 *    deliberate act, and a webhook replay must not silently undo it. Reported as
 *    `manual-protected` so the caller can surface it instead of assuming success.
 *  - An event older than the row's own updated_at is ignored, so a delayed or
 *    out-of-order delivery cannot roll a live subscription backwards. Checked
 *    against the row the initial read found AND against the row a lost insert
 *    race is re-read from, so racing the insert is not a way around the guard.
 *
 * `source` is forced to 'stripe' and `updated_at` to now, so a caller cannot
 * fabricate a manual row or backdate a write.
 *
 * FOUR WORKERS, SO THE SELECT IS A RACE, NOT A LOCK. The read above can find
 * nothing while another process is inserting the same email, and the insert then
 * fails with 23505 from UNIQUE(email). That is the losing side of a normal race,
 * not a failure: the row is re-read and updated, which is also why a lost race
 * returns `updated` with a detail instead of `error` - or `manual-protected`
 * when the row it lost to is the operator grant guarded above, or `ignored`
 * when that row is already newer than the event we hold.
 *
 * CONSEQUENCE: while a manual row stands for an email, Stripe events for that
 * email keep being reported as `manual-protected` instead of applied. An
 * operator promoting someone to a paid subscription clears the manual row first
 * (see recordManualSubscription in subscription-store.ts).
 */
export async function upsertSubscriptionFromStripe(input: StripeSubscriptionInput): Promise<SubscriptionWriteResult> {
  try {
    const existing = await findSubscriptionRow(input.email, input.stripe_subscription_id);
    if (existing) {
      if (existing.source === "manual") {
        return { ok: false, action: "manual-protected", detail: `row ${existing.id} is source=manual` };
      }
      if (isStaleEvent(input.eventCreated, existing.updated_at)) {
        return { ok: true, action: "ignored", detail: "event older than stored record" };
      }
    }

    // Built explicitly rather than spread: `eventCreated` is caller metadata
    // for the guards above and must never reach a column.
    const payload: Record<string, unknown> = {
      user_id: input.user_id,
      email: input.email,
      stripe_customer_id: input.stripe_customer_id ?? null,
      stripe_subscription_id: input.stripe_subscription_id,
      price_id: input.price_id ?? null,
      plan: input.plan ?? null,
      interval: input.interval ?? null,
      status: input.status,
      stripe_status: input.stripe_status ?? null,
      current_period_end: input.current_period_end ?? null,
      trial_ends_at: input.trial_ends_at ?? null,
      cancel_at_period_end: input.cancel_at_period_end ?? false,
      source: "stripe",
      updated_at: new Date().toISOString(),
    };

    return existing
      ? await updateRow(existing.id, payload)
      : await insertRow(input.email, payload, input.eventCreated);
  } catch (err) {
    const detail = asMessage(err);
    console.error(`[billing] upsertSubscriptionFromStripe failed for ${input.email}: ${detail}`);
    return { ok: false, action: "error", detail };
  }
}

/**
 * True when a Stripe event describes a state older than the row it would
 * overwrite. Used by BOTH paths below - the row the initial read found, and the
 * row a lost insert race is re-read from - so the two cannot drift apart.
 *
 * The comparison is the event's own occurrence time (`eventCreated`, Stripe's
 * `event.created`, in Unix seconds) against the row's `updated_at`: not arrival
 * order, and not our insert order. A webhook redelivered hours late still
 * carries the time the event happened, which is the only thing that says
 * whether it is newer than what the row already records.
 *
 * Uncomparable values FAIL OPEN - a missing `eventCreated`, or an `updated_at`
 * that does not parse, counts as "not stale" and the write proceeds. Dropping a
 * legitimate update on a bad timestamp would be worse than applying a stale one.
 */
function isStaleEvent(eventCreated: number | null | undefined, rowUpdatedAt: string): boolean {
  if (eventCreated == null) return false;
  const stored = Date.parse(rowUpdatedAt);
  return Number.isFinite(stored) && eventCreated * 1000 < stored;
}

function isUniqueViolation(error: { code?: string; message?: string }): boolean {
  return error.code === UNIQUE_VIOLATION || (error.message ?? "").includes(UNIQUE_VIOLATION);
}

async function updateRow(id: string, payload: Record<string, unknown>): Promise<SubscriptionWriteResult> {
  const { error } = await createAdminClient().from("billing_subscriptions").update(payload).eq("id", id);
  if (error) return { ok: false, action: "error", detail: error.message };
  return { ok: true, action: "updated" };
}

/**
 * Loses the race deliberately: another process inserted the same email between
 * our SELECT and our INSERT, so the row exists now. Re-read it and update it -
 * unless the winner is a manual row, or is already newer than the event we hold.
 * The concurrent writer may have been recordManualSubscription (an operator
 * grant must not be overwritten just because it landed after our SELECT), or a
 * newer Stripe event (which ours must not roll back), so the winner faces both
 * guards the initial read applies.
 */
async function insertRow(
  email: string,
  payload: Record<string, unknown>,
  eventCreated: number | null | undefined,
): Promise<SubscriptionWriteResult> {
  const { error } = await createAdminClient().from("billing_subscriptions").insert(payload);
  if (!error) return { ok: true, action: "created" };
  if (!isUniqueViolation(error)) return { ok: false, action: "error", detail: error.message };

  const winner = await findSubscriptionRow(email, null);
  if (!winner) return { ok: false, action: "error", detail: `insert lost the race but no row for ${email}` };
  if (winner.source === "manual") {
    return { ok: false, action: "manual-protected", detail: `row ${winner.id} is source=manual` };
  }
  if (isStaleEvent(eventCreated, winner.updated_at)) {
    return { ok: true, action: "ignored", detail: "event older than stored record" };
  }
  return { ...(await updateRow(winner.id, payload)), detail: "lost the insert race; updated the winning row" };
}
