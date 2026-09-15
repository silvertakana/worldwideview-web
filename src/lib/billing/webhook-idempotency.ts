import { createAdminClient } from "@/lib/supabase/admin";

export type IdempotencyVerdict = "claimed" | "completed" | "unknown";

/**
 * Claim a Stripe webhook event in the `webhook_events` idempotency ledger
 * (PMT-008, D1).
 *
 * The ledger distinguishes two states with `processed_at`:
 *   - NULL     -> claimed, never completed. The delivery that wrote the row
 *                 threw partway through, so a redelivery must be allowed to
 *                 finish the work instead of being absorbed as a duplicate.
 *   - non-null -> completed. Only this state short-circuits a redelivery.
 *
 * "claimed"   - this delivery owns the attempt; the caller should process.
 * "completed" - a finished delivery already exists; the caller must skip.
 * "unknown"   - the ledger is unreachable. Fail open: the caller processes
 *               anyway, because idempotency storage must never block payments.
 */
export async function claimWebhookEvent(eventId: string): Promise<IdempotencyVerdict> {
  try {
    const admin = createAdminClient();

    // Atomic claim: INSERT ... ON CONFLICT (event_id) DO NOTHING RETURNING id.
    // Exactly one concurrent delivery creates the row and gets it back; the
    // others get no row and fall through to the state read below. Writing
    // `processed_at: null` is what marks the row as an unfinished attempt.
    //
    // `last_attempt_at` is stamped HERE, at claim time, and not only from
    // failWebhookEvent. A process killed between the claim and the completion
    // never reaches the failure path, so without this the row keeps
    // last_attempt_at NULL - and the partial index webhook_events_unfinished_idx
    // is ordered on that column, so the freshest abandoned work sorts as NULL and
    // nothing sweeps it. DO NOTHING means an existing row is never touched, so
    // this does not change what a replay decides.
    const { data: claimed, error: claimError } = await admin
      .from("webhook_events")
      .upsert(
        { event_id: eventId, processed_at: null, last_attempt_at: new Date().toISOString() },
        { onConflict: "event_id", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();

    if (claimError) {
      console.error(`[webhook] Idempotency write failed for ${eventId}: ${claimError.message}`);
      return "unknown";
    }
    if (claimed) return "claimed";

    const { data, error: readError } = await admin
      .from("webhook_events")
      .select("processed_at")
      .eq("event_id", eventId)
      .maybeSingle();

    if (readError) {
      console.error(`[webhook] Idempotency read failed for ${eventId}: ${readError.message}`);
      return "unknown";
    }

    // No row: it was removed between the ignored insert and this read. Process,
    // and let completeWebhookEvent re-create it.
    const existing = data as { processed_at: string | null } | null;
    if (!existing) return "claimed";
    return existing.processed_at ? "completed" : "claimed";
  } catch (err) {
    console.error(
      `[webhook] Idempotency check failed for ${eventId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "unknown";
  }
}

/**
 * Mark a claimed event as completed (D1). Only a non-null `processed_at`
 * short-circuits a redelivery, so this write is what actually makes the ledger
 * idempotent.
 *
 * WRITE-ONCE. The completion is a guarded UPDATE (WHERE processed_at IS NULL)
 * rather than a blind `onConflict: event_id` upsert, because the upsert rewrote
 * `processed_at` on every replay of an already-completed event. The reconciler
 * reads this table, and a completion timestamp that moves underneath a
 * reconciler is not a completion timestamp.
 *
 * The guarded update matching nothing means one of two things, and only one of
 * them is ours to repair: the row is already complete (leave its timestamp
 * alone), or the claim itself failed open - the ledger was unreachable, so no
 * row was ever created and this is the last chance to record the event. Read
 * first to tell them apart, then insert only in the second case.
 *
 * Best-effort throughout: a ledger write failure must not change the webhook's
 * HTTP status, and an unrecorded completion only means a replay reprocesses —
 * provisioning is idempotent by contract and tier-sync is a set operation.
 */
export async function completeWebhookEvent(eventId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const completedAt = new Date().toISOString();

    const { data, error } = await admin
      .from("webhook_events")
      .update({ processed_at: completedAt, last_error: null })
      .eq("event_id", eventId)
      .is("processed_at", null)
      .select("id");

    if (error) {
      console.error(`[webhook] Could not record completion of ${eventId}: ${error.message}`);
      return;
    }
    if (data && data.length > 0) return;

    const { data: existing, error: readError } = await admin
      .from("webhook_events")
      .select("id")
      .eq("event_id", eventId)
      .maybeSingle();

    if (readError) {
      console.error(`[webhook] Could not record completion of ${eventId}: ${readError.message}`);
      return;
    }
    if (existing) return;

    const { error: insertError } = await admin
      .from("webhook_events")
      .insert({ event_id: eventId, processed_at: completedAt });

    if (insertError) {
      console.error(`[webhook] Could not record completion of ${eventId}: ${insertError.message}`);
    }
  } catch (err) {
    console.error(
      `[webhook] Could not record completion of ${eventId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Record a failed attempt against an event that is still unfinished (D1),
 * leaving `processed_at` NULL so a Stripe redelivery is allowed to reprocess.
 *
 * UPDATE ... WHERE processed_at IS NULL, never an upsert: a concurrent
 * successful delivery of the same event must not be un-completed by a failing
 * sibling. The write is a no-op when the row is missing or already completed,
 * which is the correct outcome in both cases. Best-effort — the caller answers
 * 500 regardless, and Stripe's redelivery is what recovers the event.
 */
export async function failWebhookEvent(eventId: string, error: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error: writeError } = await admin
      .from("webhook_events")
      .update({ last_error: error.slice(0, 500), last_attempt_at: new Date().toISOString() })
      .eq("event_id", eventId)
      .is("processed_at", null)
      .select("id")
      .maybeSingle();

    if (writeError) {
      console.error(`[webhook] Could not record failure of ${eventId}: ${writeError.message}`);
    }
  } catch (err) {
    console.error(
      `[webhook] Could not record failure of ${eventId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
