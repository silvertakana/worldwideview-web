import { createAdminClient } from "@/lib/supabase/admin";
import type { BillingOverride, SubscriptionRecord, SubscriptionWriteResult } from "@/lib/billing/billing-tables";
import { OVERRIDE_COLUMNS, asMessage } from "@/lib/billing/billing-tables";

/* ───────────────────────────── reads ───────────────────────────── */

/**
 * ROW SEMANTICS: one row per CUSTOMER, not per subscription.
 *
 * A customer who cancels and later re-subscribes gets their existing row
 * updated to the new stripe_subscription_id rather than a second row. That keeps
 * the reconciler's comparison against Stripe a simple per-email match, and the
 * superseded subscription stays in Stripe (the authority) plus the webhook
 * ledger, so no history is invented here. Every read helper in this module and
 * every writer (records.ts) obeys that rule.
 */

/** Every live (non-canceled) durable record, newest first - the reconciler's list. */
export async function listActiveSubscriptions(): Promise<SubscriptionRecord[]> {
  const { data, error } = await createAdminClient()
    .from("billing_subscriptions")
    .select("*")
    .neq("status", "canceled")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`[billing] listActiveSubscriptions failed: ${error.message}`);
  return (data as SubscriptionRecord[] | null) ?? [];
}

/** Every durable record for a user, newest first. Empty when nothing is on file. */
export async function getSubscriptionForUser(userId: string): Promise<SubscriptionRecord[]> {
  const { data, error } = await createAdminClient()
    .from("billing_subscriptions")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`[billing] getSubscriptionForUser failed: ${error.message}`);
  return (data as SubscriptionRecord[] | null) ?? [];
}

/** The durable record for an email - the identity Stripe checkout always has. */
export async function getSubscriptionByEmail(email: string): Promise<SubscriptionRecord | null> {
  const { data, error } = await createAdminClient()
    .from("billing_subscriptions")
    .select("*")
    .eq("email", email)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`[billing] getSubscriptionByEmail failed: ${error.message}`);
  return (data as SubscriptionRecord | null) ?? null;
}

/* ─────────────────── manual (operator) records ─────────────────── */

/**
 * The operator's way to put a subscription on file without Stripe: a comped
 * account, a support grant, a migration. Written with source = 'manual' and no
 * stripe_subscription_id, which is what makes the rows findable by email.
 *
 * CAVEAT, deliberately accepted: while a manual row exists for an email, the
 * Stripe write path refuses it (upsertSubscriptionFromStripe reports
 * `manual-protected`). That is the point - a replay must not erase a grant - but
 * it also means Stripe will not update the row while it stands. An operator
 * promoting someone to a real paid subscription must therefore revoke or clear
 * the manual row first, or the Stripe events will keep being reported as
 * protected. See the header comment in records.ts.
 */
export async function recordManualSubscription(
  input: Omit<SubscriptionRecord, "source">,
): Promise<SubscriptionWriteResult> {
  try {
    const existing = await getSubscriptionByEmail(input.email);
    if (existing && existing.source !== "manual") {
      return { ok: false, action: "ignored", detail: `row for ${input.email} is source=${String(existing.source)}` };
    }

    const payload: Record<string, unknown> = {
      ...input,
      source: "manual",
      updated_at: new Date().toISOString(),
    };
    const admin = createAdminClient();
    const { error } = existing
      ? await admin.from("billing_subscriptions").update(payload).eq("email", input.email)
      : await admin.from("billing_subscriptions").insert(payload);
    if (error) return { ok: false, action: "error", detail: error.message };
    return { ok: true, action: existing ? "updated" : "created" };
  } catch (err) {
    const detail = asMessage(err);
    console.error(`[billing] recordManualSubscription failed for ${input.email}: ${detail}`);
    return { ok: false, action: "error", detail };
  }
}

/* ─────────────────────── operator overrides ─────────────────────── */

/** The single active override for a user, or null. Read by tier-rank.ts. */
export async function getActiveOverride(userId: string): Promise<BillingOverride | null> {
  const { data, error } = await createAdminClient()
    .from("billing_overrides")
    .select(OVERRIDE_COLUMNS)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw new Error(`[billing] getActiveOverride failed: ${error.message}`);
  return (data as BillingOverride | null) ?? null;
}

/**
 * Grants an operator override. Any active override is revoked first, so the
 * partial unique index on (user_id) WHERE revoked_at IS NULL cannot reject a
 * legitimate change, while the revoked rows stay as history.
 */
export async function setOverride(
  userId: string,
  tier: string,
  reason: string,
  createdBy: string | null,
): Promise<BillingOverride | null> {
  const existing = await getActiveOverride(userId);
  if (existing) await revokeOverride(existing.id, createdBy);

  const { data, error } = await createAdminClient()
    .from("billing_overrides")
    .insert({ user_id: userId, tier, reason, created_by: createdBy })
    .select(OVERRIDE_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`[billing] setOverride failed: ${error.message}`);
  return (data as BillingOverride | null) ?? null;
}

export async function revokeOverride(overrideId: string, revokedBy: string | null): Promise<boolean> {
  const { error } = await createAdminClient()
    .from("billing_overrides")
    .update({ revoked_at: new Date().toISOString(), revoked_by: revokedBy })
    .eq("id", overrideId);
  if (error) throw new Error(`[billing] revokeOverride failed: ${error.message}`);
  return true;
}
