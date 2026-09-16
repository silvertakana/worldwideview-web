import { notify } from "@/lib/alerts/notify";
import type {
  BillingFailureInput,
  StripeSubscriptionInput,
  SubscriptionWriteResult,
} from "@/lib/billing/billing-tables";
import { asMessage } from "@/lib/billing/billing-tables";
import { recordFailure, upsertSubscriptionFromStripe } from "@/lib/billing/records";

/**
 * The webhook's view of a Stripe Subscription (and of the `subscription` object
 * expanded onto a completed Checkout Session). Declared structurally rather than
 * taken from the Stripe SDK types so the route's tests can build the payloads
 * they assert against without importing the SDK's full object graph.
 *
 * `metadata.userId` is the hub's own uid for subscriptions the hub created
 * (checkout/route.ts sets `subscription_data.metadata`) - it is a CANDIDATE, and
 * hub-user.ts is what decides whether it may be stored.
 */
export interface StripeSubscriptionLike {
  id: string;
  status?: string | null;
  customer?: string | null;
  customer_email?: string | null;
  current_period_end?: number | null;
  trial_end?: number | null;
  cancel_at_period_end?: boolean | null;
  metadata?: { userId?: string | null } | null;
  items?: {
    data?: Array<{ price?: { id?: string; recurring?: { interval?: string | null } | null } | null }>;
  } | null;
}

/**
 * Stripe timestamps are epoch SECONDS; every stored and outbound date is
 * ISO-8601. An absent or non-finite value is null, never `Invalid Date`.
 */
export function epochSecondsToIso(value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}

export function priceIdOf(subscription: StripeSubscriptionLike | null | undefined): string | null {
  return subscription?.items?.data?.[0]?.price?.id ?? null;
}

export function intervalOf(subscription: StripeSubscriptionLike | null | undefined): string | null {
  return subscription?.items?.data?.[0]?.price?.recurring?.interval ?? null;
}

/**
 * Pushes out a payment-related durable write that did not land.
 *
 * This is the ledger going dark, which is worse than it sounds: the ledger is the
 * hub's only memory of who paid for what, so a lost subscription write leaves
 * nothing to reconcile against and nothing to bill from if Stripe's copy is ever
 * in question. The console.error says so to a stream nobody is reading, which is
 * why this is a critical alert rather than another log line.
 *
 * Identifiers only: `input.email` is deliberately absent, because this is the one
 * field that names a real person and notify() strips it anyway.
 */
async function alertLostSubscriptionWrite(
  input: StripeSubscriptionInput,
  action: string,
  detail: string | undefined,
): Promise<void> {
  await notify(
    "critical",
    "Billing ledger write lost: subscription record",
    `The durable subscription record for a Stripe event was NOT written (${action})${detail ? `: ${detail}` : ""}. The hub's ledger is behind Stripe for this customer until the reconciler catches up.`,
    {
      table: "billing_subscriptions",
      action,
      userId: input.user_id ?? null,
      customerId: input.stripe_customer_id ?? null,
      subscriptionId: input.stripe_subscription_id ?? null,
    },
  );
}

/**
 * Writes the durable record and reports what happened.
 *
 * NEVER throws, and never influences the HTTP status returned to Stripe: this is
 * a ledger, not a gate. A write that fails leaves the payment itself unaffected -
 * Stripe remains the authority for the money and the globe has still been told
 * the tier - so the loud log here plus the reconciler's Stripe comparison are the
 * recovery path. The three outcomes worth distinguishing are logged distinctly:
 * a write error, a `manual-protected` refusal (an operator grant the automation
 * must not undo), and an `ignored` out-of-order event.
 */
export async function writeSubscriptionRecord(input: StripeSubscriptionInput): Promise<SubscriptionWriteResult> {
  try {
    const result = await upsertSubscriptionFromStripe(input);
    if (!result.ok) {
      console.error(
        `[webhook] Durable subscription record NOT written for ${input.email}: ${result.action}${result.detail ? ` (${result.detail})` : ""}`,
      );
      // Only `error` is a lost write. `manual-protected` is the automation
      // correctly refusing to overwrite an operator grant - a normal outcome on a
      // system that has overrides, and alerting on it is how an operator learns
      // to ignore alerts.
      if (result.action === "error") {
        await alertLostSubscriptionWrite(input, result.action, result.detail);
      }
    } else if (result.action === "ignored") {
      console.warn(
        `[webhook] Durable subscription record left alone for ${input.email}: ${result.detail ?? "out-of-order event"}`,
      );
    }
    return result;
  } catch (err) {
    const detail = asMessage(err);
    console.error(`[webhook] Durable subscription record write THREW for ${input.email}: ${detail}`);
    await alertLostSubscriptionWrite(input, "error", detail);
    return { ok: false, action: "error", detail };
  }
}

/**
 * Records a stage the delivery failed at, for an operator to work from.
 *
 * This complements the idempotency ledger rather than duplicating it: the ledger
 * row keeps the event unfinished and carries `last_error`, while this row carries
 * `attempts` and a `resolved_at` an operator can close. The two answer different
 * questions ("was this event handled?" and "is anyone still on the hook for it?"),
 * which is why a delivery that fails a stage gets both.
 *
 * A failure to record a failure is worth its own line: at that point the
 * operator's only remaining evidence is application logs, and pretending
 * otherwise is how a paid user ends up with no workspace and no trace.
 */
export async function recordStageFailure(input: BillingFailureInput): Promise<boolean> {
  const recorded = await recordFailure(input);
  if (!recorded) {
    console.error(
      `[webhook] Could not record the ${input.stage} failure for event ${input.eventId ?? "unknown"} (${input.email ?? "no customer email"}); it exists only in this log`,
    );
    await notify(
      "critical",
      `Billing ledger write lost: ${input.stage} failure not recorded`,
      `A ${input.stage} stage failure could not be written to billing_failures. It exists only in the application log, no operator queue carries it, and nothing will ever resolve it.`,
      {
        table: "billing_failures",
        stage: input.stage,
        eventId: input.eventId ?? null,
        eventType: input.eventType ?? null,
        userId: input.userId ?? null,
      },
    );
  }
  return recorded;
}
