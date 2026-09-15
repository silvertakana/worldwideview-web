/**
 * Shared types for the durable billing record - the hub's own memory of who
 * paid for what.
 *
 * Before these tables existed, nothing in the database remembered a
 * subscription: `user_entitlements` only records code redemptions and
 * `webhook_events` is a bare idempotency ledger (id, event_id, processed_at).
 * The only Stripe-to-user link lived in Stripe's own object metadata, so every
 * read re-derived plan and status live from Stripe with nothing to audit or
 * reconcile against.
 *
 * The tables (supabase/migrations/2026091512000{1,2,3}_*.sql):
 *   billing_subscriptions - the durable subscription record
 *   billing_overrides     - operator grants, with a who/why audit trail
 *   billing_failures      - business failures a Stripe retry will not fix
 *
 * The writers live in records.ts (writes) and subscription-store.ts (reads and
 * manual grants); tier ranking lives in tier-rank.ts.
 */

/** A row of billing_subscriptions. */
export interface SubscriptionRecord {
  user_id: string | null;
  email: string;
  stripe_customer_id?: string | null;
  stripe_subscription_id: string | null;
  price_id?: string | null;
  plan?: string | null;
  interval?: string | null;
  status: string;
  stripe_status?: string | null;
  current_period_end?: string | null;
  trial_ends_at?: string | null;
  cancel_at_period_end?: boolean;
  source?: "stripe" | "manual";
}

export interface StripeSubscriptionInput extends SubscriptionRecord {
  /** Stripe object timestamp, for out-of-order and manual protection. */
  eventCreated?: number | null;
}

export interface SubscriptionWriteResult {
  ok: boolean;
  action: "created" | "updated" | "ignored" | "manual-protected" | "error";
  detail?: string;
}

/** A row of billing_overrides. */
export interface BillingOverride {
  id: string;
  user_id: string;
  tier: string;
  reason: string;
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
}

/** A row of billing_failures. */
export interface BillingFailure {
  id: string;
  user_id: string | null;
  email: string | null;
  event_id: string | null;
  event_type: string | null;
  stage: string;
  error: string | null;
  attempts: number;
  first_seen_at: string;
  last_attempt_at: string;
  resolved_at: string | null;
}

export interface BillingFailureInput {
  userId?: string | null;
  email?: string | null;
  eventId?: string | null;
  eventType?: string | null;
  /**
   * `resolve` means the event could not be attributed to a customer at all;
   * `provision` writes the globe workspace; `tier_sync` pushes the paid tier.
   */
  stage: FailureStage;
  error?: string | null;
}

/**
 * The three stages the CHECK constraint on billing_failures permits
 * (20260915120003 created it with two; 20260915160000 widened it).
 */
export type FailureStage = "provision" | "tier_sync" | "resolve";

export const OVERRIDE_COLUMNS = "id, user_id, tier, reason, created_by, created_at, revoked_at";

export const FAILURE_COLUMNS =
  "id, user_id, email, event_id, event_type, stage, error, attempts, first_seen_at, last_attempt_at, resolved_at";

export function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
