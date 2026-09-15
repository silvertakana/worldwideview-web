import { notify } from "@/lib/alerts/notify";
import type { BillingFailureInput, FailureStage } from "@/lib/billing/billing-tables";
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
 *
 * THE RULE for what we then tell Stripe. A stage failure is RETRYABLE when a
 * redelivery could plausibly succeed, and the caller answers 500 so Stripe sends
 * the event again: the globe never answered at all (DNS, TLS, reset, timeout) or
 * answered 5xx. It is PERMANENT when nothing a redelivery does can change the
 * outcome, and the caller answers 200 with the work recorded as unfinished: a 4xx
 * from the globe, or a checkout that carries no hubUserId for anyone to add.
 *
 * The in-process retry is not a substitute. It is one extra attempt 500ms later
 * (SYNC_RETRY_DELAY_MS in the route), which covers a blip and nothing else; a
 * globe container restart, a deploy, or a cold start lasts far longer than that
 * window. Without the 500 the customer has paid for a workspace that is never
 * provisioned, and Stripe never tries again - the loss this file exists to stop.
 *
 * 429 is the one 4xx worth arguing about, and it is treated as permanent
 * deliberately: the globe does not rate-limit provisioning or tier-sync, so a 429
 * would mean something unexpected rather than routine backpressure, and retrying
 * it would delay finding out. Revisit isRetryableStageFailure if that changes.
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

/** A stage failure, with the retry verdict already made at the point of failure. */
export interface StageFailure {
  failure: BillingFailureInput;
  retryable: boolean;
}

/**
 * Whether Stripe's redelivery could plausibly do what this attempt could not.
 *
 * `status` is the globe's HTTP status, and `undefined` is the load-bearing case:
 * both provisionWorkspace and the tier sync swallow a transport failure into
 * `{ ok: false, detail }` with no status, and "no answer at all" is the one
 * failure a second attempt very often fixes.
 */
export function isRetryableStageFailure(status: number | undefined): boolean {
  if (status === undefined) return true;
  return status >= 500;
}

/** Whether anything queued is worth Stripe redelivering the whole event for. */
export function shouldAskStripeToRetry(failures: StageFailure[]): boolean {
  return failures.some((failure) => failure.retryable);
}

function failureBase(
  context: StageFailureContext,
  stage: FailureStage,
): Omit<BillingFailureInput, "error"> {
  return {
    stage,
    eventId: context.eventId,
    eventType: context.eventType,
    email: context.email,
    userId: context.userId,
  };
}

/**
 * Queues a globe provisioning failure - the paying customer has no workspace.
 *
 * The verdict comes from what the globe answered, which is the only evidence
 * available: a 5xx or silence is a globe that is down or restarting and worth
 * Stripe's redelivery, a 4xx is the globe having understood the request and
 * refused it, which the next identical request will be refused for as well.
 */
export function noteProvisionFailure(
  queue: StageFailure[],
  context: StageFailureContext,
  provision: { status?: number; detail?: string },
): void {
  queue.push({
    failure: {
      ...failureBase(context, "provision"),
      error: `globe provisioning failed: ${provision.status ?? "transport error"}${provision.detail ? ` (${provision.detail})` : ""}`,
    },
    retryable: isRetryableStageFailure(provision.status),
  });
}

/**
 * Queues the permanently unfixable one: the checkout session carries no hubUserId,
 * so nothing was even attempted, and no redelivery can add metadata that Stripe
 * has already delivered without it.
 */
export function noteMissingHubUserId(
  queue: StageFailure[],
  context: StageFailureContext,
  sessionId: string,
): void {
  queue.push({
    failure: {
      ...failureBase(context, "provision"),
      error: `no hubUserId on checkout session ${sessionId}; nothing was provisioned and no redelivery can add one`,
    },
    retryable: false,
  });
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
  queue: StageFailure[],
  context: StageFailureContext,
  sync: TierSyncResult,
): void {
  if (sync.ok) return;
  queue.push({
    failure: {
      ...failureBase(context, "tier_sync"),
      error: `globe tier sync failed: ${sync.status ?? "transport error"}${sync.detail ? ` (${sync.detail})` : ""}`,
    },
    retryable: isRetryableStageFailure(sync.status),
  });
}

/**
 * Raises the operator alert for one stage failure, right where it is filed.
 *
 * The failure row is durable but passive: it waits for someone to open the table.
 * A provisioning failure or a failed tier push means a paying customer has no
 * workspace, or is billed for a tier their globe is not running, and that cannot
 * wait for a human to go looking - so the same failure that is recorded is also
 * pushed out.
 *
 * The LEVEL is the retry verdict and nothing else. A retryable failure (globe
 * silent or 5xx) is a warning: Stripe is about to redeliver it and it very often
 * just fixes itself. A permanent one is critical: nothing but a human editing the
 * checkout metadata or the globe's state will ever resolve it.
 *
 * Only identifiers travel. `email` is on the context the queue carries and is
 * deliberately left out of the alert - it is the one field that identifies a real
 * person, and notify() would strip it anyway.
 */
async function alertStageFailure({ failure, retryable }: StageFailure): Promise<void> {
  await notify(
    retryable ? "warning" : "critical",
    `Billing stage failure: ${failure.stage}`,
    `${failure.eventType ?? "unknown event"} ${failure.eventId ?? "unknown id"}: ${failure.error ?? "no detail"}`,
    {
      stage: failure.stage,
      eventId: failure.eventId ?? null,
      eventType: failure.eventType ?? null,
      userId: failure.userId ?? null,
      retryable,
    },
  );
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
 * The status code the caller answers with still depends on whether any of these
 * failures is retryable: see the rule at the top of this file.
 */
export async function abandonIncompleteDelivery(
  eventId: string,
  eventType: string,
  failures: StageFailure[],
): Promise<void> {
  for (const stageFailure of failures) {
    await recordStageFailure(stageFailure.failure);
    await alertStageFailure(stageFailure);
  }
  const summary = failures.map(({ failure }) => `${failure.stage}: ${failure.error}`).join("; ");
  const retry = shouldAskStripeToRetry(failures);
  await failWebhookEvent(eventId, summary);
  console.warn(
    `[webhook] Event ${eventId} (${eventType}) handled but NOT completed (${retry ? "retryable, answering 500" : "permanent, answering 200"}): ${summary}`,
  );
}
