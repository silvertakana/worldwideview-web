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
    const { data: claimed, error: claimError } = await admin
      .from("webhook_events")
      .upsert(
        { event_id: eventId, processed_at: null },
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
 * Upsert rather than update: when the claim itself failed open (ledger
 * unreachable), no row exists yet and this is the only chance to record it.
 * Best-effort: a ledger write failure must not change the webhook's HTTP
 * status, and an unrecorded completion only means a replay reprocesses —
 * provisioning is idempotent by contract and tier-sync is a set operation.
 */
export async function completeWebhookEvent(eventId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("webhook_events")
      .upsert(
        { event_id: eventId, processed_at: new Date().toISOString(), last_error: null },
        { onConflict: "event_id" },
      )
      .select("id")
      .maybeSingle();

    if (error) {
      console.error(`[webhook] Could not record completion of ${eventId}: ${error.message}`);
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
