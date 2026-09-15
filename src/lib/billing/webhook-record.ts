import type { StripeSubscriptionInput, SubscriptionWriteResult } from "@/lib/billing/billing-tables";
import { asMessage } from "@/lib/billing/billing-tables";
import { upsertSubscriptionFromStripe } from "@/lib/billing/records";

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
    } else if (result.action === "ignored") {
      console.warn(
        `[webhook] Durable subscription record left alone for ${input.email}: ${result.detail ?? "out-of-order event"}`,
      );
    }
    return result;
  } catch (err) {
    const detail = asMessage(err);
    console.error(`[webhook] Durable subscription record write THREW for ${input.email}: ${detail}`);
    return { ok: false, action: "error", detail };
  }
}
