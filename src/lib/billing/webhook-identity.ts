import type Stripe from "stripe";
import { firstVerifiedHubUserId } from "@/lib/billing/hub-user";

/**
 * Who a Stripe event is about, and what to do when that cannot be established.
 *
 * Everything the handler does is keyed on the customer email: it is the durable
 * record's identity (UNIQUE(email)) and the tier sync's key. An event whose email
 * cannot be resolved therefore cannot be handled at all, and the only question
 * left is whether asking again would help. That question is what this module
 * answers, because it is the difference between a Stripe retry and an operator
 * opening a ticket.
 */

/** The payload fields that can carry a customer email. */
export interface PayloadEmailFields {
  customer_email?: string | null;
  customer_details?: { email?: string | null } | null;
  customer?: string | { email?: string | null } | null;
  metadata?: { email?: string | null; userId?: string | null } | null;
}

/**
 * Payload-first email resolution (PMT-009). Stripe already sends the customer's
 * email on most events (`customer_email`, `customer_details.email`, an expanded
 * `customer` object); the hub's own flows also set `metadata.email`. Prefer those
 * over calling Stripe: the offline webhook simulator then drives tier-sync
 * assertions with no Stripe network at all, and the common production case
 * (checkout session, subscription) needs no second API call.
 *
 * `customer` is usually a bare id, and only an object carries an inline email, so
 * this returns null far more often than it returns the id-shaped case. That is
 * not a failure: the caller keeps the outbound retrieve as the fallback.
 */
export function emailFromPayload(obj: PayloadEmailFields): string | null {
  if (obj.customer_email) return obj.customer_email;
  if (obj.customer_details?.email) return obj.customer_details.email;
  if (typeof obj.customer === "object" && obj.customer !== null && obj.customer.email) {
    return obj.customer.email;
  }
  return null;
}

/** The two distinguishable ways an event has no customer email. */
export type IdentityGap = "unavailable" | "absent";

/**
 * Raised when an event cannot be attributed to a customer.
 *
 * `kind` is load-bearing, and is the reason this is an error rather than a null
 * return. Both cases look identical at the call site - `email === null` - but they
 * are not the same event:
 *
 *   unavailable - the outbound Stripe call did not answer (429, 5xx, DNS, TLS).
 *                 The email probably exists; we never got to look. A redelivery
 *                 is very likely to succeed, so the handler answers 500 and lets
 *                 Stripe retry.
 *   absent      - Stripe answered and there is no email anywhere, neither on the
 *                 payload nor on the customer. Retrying will never produce one,
 *                 so the event is recorded durably as an operator's problem.
 *
 * Collapsing the two into one "no email, skip it" branch is what the webhook
 * route used to do, and it turned a transient blip on
 * `customer.subscription.deleted` into a cancellation that vanished: the event
 * was marked complete, the redelivery was absorbed as a duplicate, no lock was
 * ever armed, and the customer kept access for free with nothing recording why.
 */
export class UnresolvedIdentityError extends Error {
  readonly kind: IdentityGap;

  constructor(kind: IdentityGap, message: string) {
    super(message);
    this.name = "UnresolvedIdentityError";
    this.kind = kind;
  }
}

interface CustomerContext {
  email: string | null;
  userId: string | null;
}

/**
 * Outbound fallback when the payload carries no email: retrieve the customer and
 * read BOTH facts the handler wants off that one object - the email, and the
 * `metadata.userId` candidate the hub writes when it creates the customer
 * (checkout/route.ts). One retrieve serves both, so resolving the hub user id
 * costs no extra API call.
 *
 * A retrieve FAILURE is rethrown as `unavailable`, never swallowed: swallowing
 * it is how a Stripe blip became a permanently unhandled event. A retrieve that
 * succeeds and has no email returns two nulls, because that is a real absence
 * and the caller reports it as one. A deleted customer has neither.
 */
async function resolveCustomerContext(stripe: Stripe, customerId: string): Promise<CustomerContext> {
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted) return { email: null, userId: null };
    return { email: customer.email, userId: customer.metadata?.userId ?? null };
  } catch (err) {
    throw new UnresolvedIdentityError(
      "unavailable",
      `could not retrieve Stripe customer ${customerId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface ResolvedIdentity {
  email: string;
  userId: string | null;
  customerId: string | null;
}

/**
 * The identity an event is processed under, or a throw explaining why there is
 * none. Never returns null: a caller has no sensible third option between
 * "handle this" and "fail this", and the old null return is exactly what let the
 * route fall through to a 200 that claimed the work was done.
 *
 * The hub user id is a candidate, never a fact (hub-user.ts): `metadata.userId`
 * is written by the hub AND by the marketplace, so an unvalidated value may be a
 * Prisma cuid belonging to no one here. Email remains the identity; the user id
 * is a convenience that may legitimately be null.
 */
export async function resolveIdentity(
  stripe: Stripe,
  payload: PayloadEmailFields,
  hubUserIdCandidates: Array<string | null | undefined>,
): Promise<ResolvedIdentity> {
  const payloadEmail = emailFromPayload(payload) || payload.metadata?.email || null;
  const customerId = typeof payload.customer === "string" ? payload.customer : null;
  const outbound =
    payloadEmail === null && customerId ? await resolveCustomerContext(stripe, customerId) : null;

  const email = payloadEmail ?? outbound?.email ?? null;
  if (!email) {
    throw new UnresolvedIdentityError(
      "absent",
      customerId
        ? `no usable customer email: Stripe customer ${customerId} has no email and the event payload carries none`
        : "no usable customer email: the event payload carries no email and names no customer to look one up on",
    );
  }

  return {
    email,
    userId: await firstVerifiedHubUserId([...hubUserIdCandidates, outbound?.userId]),
    customerId,
  };
}
