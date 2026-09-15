import { asMessage } from "@/lib/billing/billing-tables";
import { GLOBE_TIERS, isGlobeTier } from "@/lib/billing/globe-tiers";
import { pushTierToGlobe } from "@/lib/billing/globe-sync";
import { revokeOverride, setOverride } from "@/lib/billing/subscription-store";
import { listUnresolvedFailures, recordFailure, resolveFailure } from "@/lib/billing/records";
import { resolveEffectiveHubTier } from "@/lib/billing/tier-rank";

/**
 * What the operator screen actually does, kept out of the server-action file so
 * it can be tested as plain logic.
 *
 * The shape of a grant is two writes that can disagree:
 *
 *   1. the HUB records the decision (billing_overrides: tier, reason, who, when)
 *   2. the GLOBE is told, because that is where access lives
 *
 * If (1) lands and (2) does not, the customer still has NO access. That state is
 * reported as a failure with the override id attached, and an unresolved row is
 * filed in billing_failures so it shows up in the operator's work queue and can
 * be retried with one click.
 */

export type OverrideStage = "unauthorized" | "validation" | "hub" | "globe";

export type GrantOverrideResult =
  | { ok: true; overrideId: string | null; detail: string }
  /** `overrideId` is present when the hub write landed but the globe push did not. */
  | { ok: false; stage: OverrideStage; error: string; overrideId?: string };

export type RevokeOverrideResult =
  | { ok: true; tier: string; globe: "synced" | "skipped" | "failed"; detail: string }
  | { ok: false; stage: OverrideStage; error: string };

export type RetryPushResult =
  | { ok: true; detail: string }
  | { ok: false; stage: "unauthorized" | "validation" | "globe"; error: string };

/**
 * billing_failures keys a manual-override push by customer, so repeated attempts
 * count up on one row instead of filling the queue with duplicates. The webhook's
 * own failures carry the Stripe event id, so the two never collide.
 */
export function manualOverrideFailureKey(userId: string): string {
  return `manual-override:${userId}`;
}

const TIER_HELP = `Tier must be one of: ${GLOBE_TIERS.join(", ")}.`;

export async function grantManualOverride(input: {
  userId: string;
  email: string;
  tier: string;
  reason: string;
  createdBy: string | null;
}): Promise<GrantOverrideResult> {
  const tier = input.tier;
  const reason = input.reason.trim();

  if (!input.userId.trim() || !input.email.trim()) {
    return { ok: false, stage: "validation", error: "A customer is required." };
  }
  if (!isGlobeTier(tier)) {
    return { ok: false, stage: "validation", error: TIER_HELP };
  }
  if (!reason) {
    return {
      ok: false,
      stage: "validation",
      error:
        "A reason is required. An override with no reason is indistinguishable from an accident " +
        "six months from now.",
    };
  }

  let overrideId: string | null = null;
  try {
    const row = await setOverride(input.userId, tier, reason, input.createdBy);
    overrideId = row?.id ?? null;
  } catch (err) {
    return { ok: false, stage: "hub", error: `The hub could not record the override: ${asMessage(err)}` };
  }

  const pushed = await pushTierToGlobe({ email: input.email, tier });
  if (pushed.ok) {
    return { ok: true, overrideId, detail: `Override recorded, and ${pushed.detail}` };
  }

  await recordFailure({
    userId: input.userId,
    email: input.email,
    eventId: manualOverrideFailureKey(input.userId),
    eventType: "manual_override",
    stage: "tier_sync",
    error: pushed.detail,
  });
  return { ok: false, stage: "globe", error: pushed.detail, overrideId: overrideId ?? undefined };
}

/**
 * Revoking is not just deleting a row: the globe is still granting whatever the
 * override pushed. So the hub tier is re-resolved from the customer's remaining
 * sources (Stripe, entitlements) and that is what gets mirrored.
 *
 * When what remains cannot be expressed on the globe (a `beta_tester` or
 * `early_access` entitlement, which tier-sync rejects), the mirror is deliberately
 * left alone: over-granting is the recoverable failure direction, and silently
 * downgrading someone to free is not.
 */
export async function revokeManualOverride(input: {
  userId: string;
  email: string;
  overrideId: string;
  revokedBy: string | null;
}): Promise<RevokeOverrideResult> {
  if (!input.userId.trim() || !input.overrideId.trim()) {
    return { ok: false, stage: "validation", error: "An active override is required." };
  }

  try {
    await revokeOverride(input.overrideId, input.revokedBy);
  } catch (err) {
    return { ok: false, stage: "hub", error: `The hub could not revoke the override: ${asMessage(err)}` };
  }

  const resolution = await resolveEffectiveHubTier(input.userId, input.email);
  const tier = resolution.tier;

  if (!isGlobeTier(tier)) {
    return {
      ok: true,
      tier,
      globe: "skipped",
      detail:
        `Override revoked. The customer's remaining hub tier is "${tier}" (${resolution.source}), ` +
        "which the globe cannot represent, so its tier mirror was left where it was.",
    };
  }

  const pushed = await pushTierToGlobe({ email: input.email, tier });
  if (pushed.ok) {
    return { ok: true, tier, globe: "synced", detail: `Override revoked, and ${pushed.detail}` };
  }

  await recordFailure({
    userId: input.userId,
    email: input.email,
    eventId: manualOverrideFailureKey(input.userId),
    eventType: "manual_override",
    stage: "tier_sync",
    error: pushed.detail,
  });
  return {
    ok: true,
    tier,
    globe: "failed",
    detail: `Override revoked, but the globe is still granting the old tier: ${pushed.detail}`,
  };
}

/** Re-sends a tier the globe did not accept, and closes the failure row on success. */
export async function retryManualOverridePush(input: {
  userId: string;
  email: string;
  tier: string;
}): Promise<RetryPushResult> {
  const tier = input.tier;
  if (!isGlobeTier(tier)) return { ok: false, stage: "validation", error: TIER_HELP };

  const pushed = await pushTierToGlobe({ email: input.email, tier });
  if (!pushed.ok) {
    await recordFailure({
      userId: input.userId,
      email: input.email,
      eventId: manualOverrideFailureKey(input.userId),
      eventType: "manual_override",
      stage: "tier_sync",
      error: pushed.detail,
    });
    return { ok: false, stage: "globe", error: pushed.detail };
  }

  await closeManualOverrideFailure(input.userId);
  return { ok: true, detail: pushed.detail };
}

async function closeManualOverrideFailure(userId: string): Promise<void> {
  try {
    const key = manualOverrideFailureKey(userId);
    const open = (await listUnresolvedFailures()).find(
      (failure) => failure.stage === "tier_sync" && failure.event_id === key,
    );
    if (open) await resolveFailure(open.id);
  } catch (err) {
    // The push already landed. A bookkeeping failure must not turn it into an error.
    console.error(`[billing] could not close the override failure row for ${userId}: ${asMessage(err)}`);
  }
}
