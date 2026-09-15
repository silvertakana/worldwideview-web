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

/**
 * Why there is no `.upsert()` here: the unique index that lets a manual row
 * carry no stripe_subscription_id is PARTIAL (WHERE stripe_subscription_id IS
 * NOT NULL), and PostgREST resolves an onConflict target to the index name,
 * which fails with 42P10 against a partial index. Hence an explicit
 * read-then-insert-or-update; the index still prevents a duplicate live row.
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
 *    out-of-order delivery cannot roll a live subscription backwards.
 *
 * `source` is forced to 'stripe' and `updated_at` to now, so a caller cannot
 * fabricate a manual row or backdate a write.
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
      const stored = Date.parse(existing.updated_at);
      if (input.eventCreated != null && Number.isFinite(stored) && input.eventCreated * 1000 < stored) {
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

    const admin = createAdminClient();
    const { error } = existing
      ? await admin.from("billing_subscriptions").update(payload).eq("id", existing.id)
      : await admin.from("billing_subscriptions").insert(payload);
    if (error) return { ok: false, action: "error", detail: error.message };
    return { ok: true, action: existing ? "updated" : "created" };
  } catch (err) {
    const detail = asMessage(err);
    console.error(`[billing] upsertSubscriptionFromStripe failed for ${input.email}: ${detail}`);
    return { ok: false, action: "error", detail };
  }
}
