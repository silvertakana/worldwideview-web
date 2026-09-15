import type { BillingFailureInput } from "@/lib/billing/billing-tables";
import { recordStageFailure } from "@/lib/billing/webhook-record";
import { failWebhookEvent } from "@/lib/billing/webhook-idempotency";

/**
 * What a delivery achieved, and what to do when it achieved nothing (D8).
 *
 * "The handler ran" and "the work was done" are different claims, and the webhook
 * used to make only the first while reporting both: a provisioning call that
 * failed and a tier sync that gave up after two attempts left the paid customer
 * with no workspace (or the wrong tier) and the ledger marked complete, so every
 * redelivery was absorbed as a duplicate and nothing could ever retry it.
 */

export interface TierSyncResult {
  ok: boolean;
  status?: number;
  detail?: string;
}

/** The identifying facts every stage failure is filed against. */
export interface StageFailureContext {
  eventId: string;
  eventType: string;
  email: string;
  userId: string | null;
}

/**
 * Queues the tier-sync failure a delivery has to leave visible.
 *
 * The sync's own log line is not enough: nobody reads an error stream in the
 * moment, it carries no attempt counter, and nothing can close it. Until the push
 * succeeds the customer's workspace sits at the wrong tier while they are billed
 * for the right one, so it belongs in the table an operator works from.
 */
export function noteTierSyncFailure(
  queue: BillingFailureInput[],
  context: StageFailureContext,
  sync: TierSyncResult,
): void {
  if (sync.ok) return;
  queue.push({
    stage: "tier_sync",
    eventId: context.eventId,
    eventType: context.eventType,
    email: context.email,
    userId: context.userId,
    error: `globe tier sync failed: ${sync.status ?? "transport error"}${sync.detail ? ` (${sync.detail})` : ""}`,
  });
}

/**
 * Closes out a delivery that ran but did not do its work.
 *
 * Files one durable failure per stage, and leaves the EVENT UNFINISHED - that is
 * the part that matters. A completed event absorbs every redelivery as a
 * duplicate, so completion is what made "handled" unfalsifiable; the unfinished
 * row is what the reconciler selects on (webhook_events_unfinished_idx) and what
 * carries the attempts counter an operator needs.
 *
 * The caller still answers 200. A 500 would ask Stripe to redeliver work that a
 * redelivery cannot fix - a checkout session never grows the metadata.userId it
 * is missing, and the globe endpoint was already retried in-process - which buys
 * a week of identical failures and a Stripe delivery log full of noise for
 * nothing. The reason this is safe is the unfinished row, not the status code.
 */
export async function abandonIncompleteDelivery(
  eventId: string,
  eventType: string,
  failures: BillingFailureInput[],
): Promise<void> {
  for (const failure of failures) {
    await recordStageFailure(failure);
  }
  const summary = failures.map((failure) => `${failure.stage}: ${failure.error}`).join("; ");
  await failWebhookEvent(eventId, summary);
  console.warn(`[webhook] Event ${eventId} (${eventType}) handled but NOT completed: ${summary}`);
}
