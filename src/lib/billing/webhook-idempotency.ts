import { createAdminClient } from "@/lib/supabase/admin";

export type IdempotencyVerdict = "processed" | "duplicate" | "unknown";

/**
 * Claim a Stripe webhook event in the `webhook_events` idempotency ledger
 * (PMT-008).
 *
 * The unique constraint on event_id turns duplicate deliveries into a no-op:
 * upsert with ignoreDuplicates maps to INSERT ... ON CONFLICT (event_id) DO
 * NOTHING, so exactly one claim wins and every later claim returns no row —
 * which the caller treats as "already processed" and skips. The insert-and-
 * check is atomic, so two concurrent deliveries of the same event cannot both
 * process.
 *
 * Fail-open: if the idempotency store is unavailable (Supabase down, missing
 * service role key), returns "unknown" so the caller processes the event
 * anyway. Idempotency storage must never block webhook processing.
 */
export async function claimWebhookEvent(eventId: string): Promise<IdempotencyVerdict> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("webhook_events")
      .upsert({ event_id: eventId }, { onConflict: "event_id", ignoreDuplicates: true })
      .select("id")
      .maybeSingle();

    if (error) {
      console.error(`[webhook] Idempotency write failed for ${eventId}: ${error.message}`);
      return "unknown";
    }
    if (!data) {
      return "duplicate";
    }
    return "processed";
  } catch (err) {
    console.error(
      `[webhook] Idempotency check failed for ${eventId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "unknown";
  }
}
