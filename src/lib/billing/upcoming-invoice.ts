import { notify } from "@/lib/alerts/notify";
import { formatPrice } from "@/lib/billing/constants";

/**
 * The founder-side warning that a customer is about to be charged for the first
 * time.
 *
 * WHY invoice.upcoming, AND NOT trial_will_end. The first buyers did not get a
 * trial. Their free month is a Stripe coupon (percent_off 100, duration "once"),
 * and `customer.subscription.trial_will_end` only ever fires for a subscription
 * with a trial - so a handler on that event would be code that never runs, and on
 * day 31 the founder's first signal would be a refund request instead of a
 * payment. `invoice.upcoming` is the event Stripe fires a few days BEFORE a
 * renewal is finalized, which is exactly the notice this needs.
 *
 * WHAT THIS READS, AND WHAT IT REFUSES TO. An invoice.upcoming payload carries a
 * PREVIEW invoice, not a finalized one:
 *   - amount_due, currency, customer, subscription are the projected values and
 *     are what this module uses.
 *   - `id` is NOT used anywhere. Invoice.id is nullable in the SDK's own types
 *     ("the definition is used for both Invoice and UpcomingInvoice and does not
 *     always have an ID"), so anything keyed on it misbehaves here. Idempotency
 *     is the webhook event id, as on every other handler.
 *   - `amount_paid` is not read: on a not-yet-finalized invoice it means nothing.
 *     The guard is amount_due > 0.
 *   - NOTHING here reconciles, grants or writes. This event moves no money and
 *     must not change an entitlement. It exists to warn a human.
 *
 * WHY THE ALERT CARRIES NO CUSTOMER EMAIL. notify() redacts every email address
 * it is given, by design and by test (src/lib/alerts/notify.ts, and
 * notify.test.ts "never lets a customer email ... reach the wire"). So this
 * alert names the customer by the Stripe customer id and subscription id, which
 * is what an operator looks up in the dashboard. Putting the address in would
 * only produce "[redacted]" where a person expected to read it.
 */
export interface UpcomingInvoiceLike {
  amount_due?: number | null;
  currency?: string | null;
  customer?: string | null;
  subscription?: string | null;
  /** Epoch SECONDS. The date Stripe intends to make the charge. */
  next_payment_attempt?: number | null;
  /** Epoch SECONDS. The fallback when there is no payment attempt yet. */
  period_end?: number | null;
  /** Pre-discount total, in the smallest currency unit. */
  subtotal?: number | null;
  total_discount_amounts?: Array<{ amount?: number | null }> | null;
  discounts?: unknown[] | null;
}

export interface UpcomingCharge {
  /** In the currency's smallest unit (cents). */
  amount: number;
  /** Upper-cased ISO code; "usd" in a Stripe payload, "USD" everywhere else. */
  currency: string;
  customerId: string | null;
  subscriptionId: string | null;
  /** The date the charge is expected, as YYYY-MM-DD, or null if not stated. */
  chargeDate: string | null;
  /** Whether this invoice still shows a discount being applied to it. */
  discounted: boolean;
}

/** Epoch seconds to a plain date. A date, not a timestamp: this is a heads-up. */
function chargeDateOf(invoice: UpcomingInvoiceLike): string | null {
  const epoch = invoice.next_payment_attempt ?? invoice.period_end ?? null;
  if (epoch === null || epoch === undefined || !Number.isFinite(epoch)) return null;
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

/**
 * Whether this preview invoice is still discounted.
 *
 * Informational only, and deliberately NOT a gate - see the note on the caller.
 * Two signals, because either can be the one Stripe sends: an amount knocked off
 * the subtotal, or a discount object still attached to the invoice.
 */
function isDiscounted(invoice: UpcomingInvoiceLike): boolean {
  const subtotal = invoice.subtotal ?? 0;
  const amountDue = invoice.amount_due ?? 0;
  if (Number.isFinite(subtotal) && Number.isFinite(amountDue) && subtotal > amountDue) return true;

  const amounts = invoice.total_discount_amounts ?? [];
  if (Array.isArray(amounts) && amounts.some((entry) => (entry?.amount ?? 0) > 0)) return true;

  return (invoice.discounts?.length ?? 0) > 0;
}

/**
 * The decision, split out from the alerting so it can be tested without a
 * transport, a clock or a webhook.
 *
 * Returns null when there is nothing to say: a zero or missing amount_due is the
 * comped cycle itself (the 100%-off coupon makes the first month's preview
 * zero), and a "you are about to be charged" alert on a $0 invoice would be
 * false.
 */
export function upcomingChargeWarning(invoice: UpcomingInvoiceLike): UpcomingCharge | null {
  const amount = invoice.amount_due ?? 0;
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return {
    amount,
    currency: (invoice.currency ?? "").toUpperCase() || "UNKNOWN",
    customerId: invoice.customer ?? null,
    subscriptionId: invoice.subscription ?? null,
    chargeDate: chargeDateOf(invoice),
    discounted: isDiscounted(invoice),
  };
}

export type UpcomingChargeOutcome = "warned" | "zero-amount";

/**
 * Raises the warning, once per distinct charge.
 *
 * IDEMPOTENT BY EVENT, AND QUIET WHEN REPEATED. Two layers, neither of which
 * needs the invoice id:
 *   - Stripe's redelivery of the same event is absorbed before this runs, by the
 *     webhook ledger (claimWebhookEvent/completeWebhookEvent on event.id).
 *   - The title and message are built ONLY from the customer, the amount and the
 *     date. Stripe can send more than one upcoming invoice for the same renewal
 *     as the date approaches, and because nothing volatile (no "now", no event
 *     id) enters the text, those duplicates are byte-identical and collapse
 *     inside notify()'s own dedupe window instead of alerting twice. The day
 *     genuinely changing is a new fact, and alerts again, which is correct.
 */
export async function alertUpcomingCharge(input: {
  eventId: string;
  eventType: string;
  invoice: UpcomingInvoiceLike;
}): Promise<UpcomingChargeOutcome> {
  const warning = upcomingChargeWarning(input.invoice);
  if (!warning) {
    console.log("[webhook] invoice.upcoming carries nothing to charge; no warning raised");
    return "zero-amount";
  }

  const amount = formatPrice(warning.amount, warning.currency);
  const when = warning.chargeDate ?? "a date Stripe has not fixed yet";

  await notify(
    "warning",
    `Upcoming charge: ${amount} on ${when}`,
    `Stripe is about to charge a customer ${amount}. The charge is expected on ${when}. ` +
      "This is the founder-side heads-up: send them a short personal note before it lands. " +
      "It is a PREVIEW invoice, so the amount and the date can still change. " +
      "No customer email is in this alert - notify() strips email addresses by design - " +
      "so resolve the customer from the ids in the context; the Stripe customer id is what " +
      "the Stripe dashboard searches on." +
      (warning.discounted
        ? " This invoice still shows a discount being applied."
        : " This invoice shows no discount, which is what a comped month looks like on the renewal that follows it."),
    {
      eventId: input.eventId,
      eventType: input.eventType,
      amountDue: warning.amount,
      currency: warning.currency,
      customerId: warning.customerId,
      subscriptionId: warning.subscriptionId,
      chargeDate: warning.chargeDate,
      discounted: warning.discounted,
    },
  );

  console.log(
    `[webhook] invoice.upcoming warning raised: ${amount} due on ${when}`,
  );
  return "warned";
}
