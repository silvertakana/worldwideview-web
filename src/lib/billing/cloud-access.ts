import { getHighestTier } from "@/lib/auth/entitlements";
import { asMessage, type SubscriptionRecord } from "@/lib/billing/billing-tables";
import { readGlobeTier } from "@/lib/billing/globe-sync";
import { isGlobeTier, type GlobeTier } from "@/lib/billing/globe-tiers";
import { getActiveOverride, getSubscriptionByEmail, getSubscriptionForUser } from "@/lib/billing/subscription-store";
import { tierRank } from "@/lib/billing/tier-rank";

/**
 * Whether an account may use the cloud edition, and at what tier.
 *
 * WHY THIS MODULE EXISTS. Cloud access used to be decided by
 * `hasInstanceEntitlement()` - "does this user have a row in
 * `user_entitlements`" - which is the ACCESS-CODE table. That made a redemption
 * code the only door: a customer who paid was refused a workspace with "No
 * active entitlement. Redeem an access code at /accounts/redeem", the instances
 * page called them Free, and the tier stamped onto the globe workspace they did
 * get was code-derived. Measured against production: the single live paying
 * account (`billing_subscriptions`: plan `pro`, status `active`) has ZERO
 * `user_entitlements` rows.
 *
 * So the hub's own durable records decide here, in this order:
 *
 *   1. `subscription` - `billing_subscriptions`, written from Stripe webhooks
 *                       and by operator grants (`source = 'manual'`)
 *   2. `override`     - `billing_overrides`, an audited operator grant
 *   3. `legacy-code`  - `user_entitlements`, the redemption-code store
 *
 * The highest-ranked tier wins, and the order above breaks ties - the same
 * doctrine as `resolveEffectiveHubTier()` in tier-rank.ts. This module
 * deliberately does NOT call that function: its Stripe leg re-derives the
 * subscription from the Stripe API on every request, which is both slow and
 * wrong for a gate (a Stripe outage must not lock a paying customer out of a
 * page they have already paid for). The durable record is the hub's own memory
 * of the same fact, read from Supabase.
 *
 * The code leg is NOT a shim to be deleted once it stops being convenient: it
 * is how the accounts already holding a redeemed code keep working now that the
 * code surfaces are hidden (12 active `beta_tester` holders at the time of
 * writing). Dropping it would cut off everyone who was promised beta access.
 */

export type AccessSource = "subscription" | "override" | "legacy-code" | "none";

/** The three stores that can grant access, in tie-breaking order. */
const RESOLUTION_ORDER = ["override", "subscription", "legacy-code"] as const;

type GrantSource = (typeof RESOLUTION_ORDER)[number];

export interface CloudAccess {
  /** True when the account may create and use cloud workspaces. */
  allowed: boolean;
  /** Which store granted it; "none" when nothing did. */
  source: AccessSource;
  /** The tier the grant resolves to ("free" when nothing was found). */
  tier: string;
  /** Customer-facing plan label: the tier, except free, which reads "local". */
  plan: string;
  /** How many workspaces the account may hold; null means unlimited. */
  instanceLimit: number | null;
  /** What each store contributed; null means that store found nothing. */
  tiers: Record<GrantSource, string | null>;
  /** Present for each store that threw. A resolution is still returned. */
  errors: Partial<Record<GrantSource, string>>;
}

/**
 * Stripe statuses that still mean "this customer has access", as stored in
 * `billing_subscriptions.status` (the hub status vocabulary, not Stripe's raw
 * one). `past_due` keeps access on purpose - Stripe is still retrying - while
 * `suspended` (unpaid/paused) and `canceled` are denials.
 */
const LIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);

/**
 * Instance allowance per tier. `null` is unlimited.
 *
 * `free` is 0, NOT null: this map previously lived in the workspace route as
 * `free: null`, i.e. unlimited, and the only thing stopping a free account from
 * being unlimited was the entitlement gate refusing it outright. Now that this
 * module answers both questions, an account with no access must not read as
 * unlimited to anything that consults the limit alone.
 */
const INSTANCE_LIMITS: Record<string, number | null> = {
  free: 0,
  beta_tester: 1,
  early_access: 3,
  pro: null,
  team: null,
  enterprise: null,
};

/**
 * How many workspaces a tier may hold; null means unlimited.
 *
 * The key test is the point. `INSTANCE_LIMITS[tier] ?? 0` treats the deliberate
 * `null` of an unlimited paid tier as "missing" and hands back 0, denying the
 * very tiers that are meant to be unlimited - so the lookup asks whether the
 * tier is known at all, and only then reads its value.
 */
function instanceLimitFor(tier: string): number | null {
  if (!Object.hasOwn(INSTANCE_LIMITS, tier)) return 0;
  return INSTANCE_LIMITS[tier] ?? null;
}

/** Shown to a customer who cannot create a workspace. Names the way out. */
export const NO_ACCESS_MESSAGE = "No active plan. Choose a plan at /pricing to create your workspace.";

/** The instances page has always rendered the free plan as "local"; keep that label. */
function planLabelFor(tier: string): string {
  return tier === "free" ? "local" : tier;
}

/**
 * The plan of the customer's current subscription, or null.
 *
 * Rows arrive newest first, so the first live one is the current plan. A row
 * whose plan ranks as free grants nothing (an active row with `plan = 'free'`
 * is a ledger artifact, not a purchase).
 */
function liveSubscriptionTier(rows: SubscriptionRecord[]): string | null {
  for (const row of rows) {
    if (!LIVE_SUBSCRIPTION_STATUSES.has(row.status)) continue;
    if (row.plan && tierRank(row.plan) > 0) return row.plan;
  }
  return null;
}

/**
 * A subscription matched by user id, then by email.
 *
 * The email fallback is not belt-and-braces: `billing_subscriptions.user_id` is
 * nullable, and the webhook records a `resolve`-stage failure precisely when an
 * event could not be attributed to a user. Email is the identity Stripe
 * checkout always has and the identity the reconciler matches on, so a paying
 * customer whose row lost its `user_id` must still be recognised as paying.
 */
async function subscriptionTier(userId: string, email: string | null): Promise<string | null> {
  const own = liveSubscriptionTier(await getSubscriptionForUser(userId));
  if (own) return own;
  if (!email) return null;
  const byEmail = await getSubscriptionByEmail(email);
  return byEmail ? liveSubscriptionTier([byEmail]) : null;
}

/**
 * Resolve cloud access for one account.
 *
 * Every store is attempted; one that throws is recorded in `errors` and simply
 * does not compete, so a broken store can never hide another store's grant. The
 * result is a DENIAL only when no store produced a tier at all - which is also
 * what happens when every store is broken, so an unreachable Supabase fails
 * closed rather than letting anyone in.
 */
export async function resolveCloudAccess(input: { userId: string; email?: string | null }): Promise<CloudAccess> {
  const { userId } = input;
  const email = input.email ?? null;

  const tiers: CloudAccess["tiers"] = { subscription: null, override: null, "legacy-code": null };
  const errors: CloudAccess["errors"] = {};

  const attempts: Array<{ source: GrantSource; run: () => Promise<string | null> }> = [
    { source: "subscription", run: async () => await subscriptionTier(userId, email) },
    { source: "override", run: async () => (await getActiveOverride(userId))?.tier ?? null },
    {
      source: "legacy-code",
      run: async () => {
        const tier = await getHighestTier(userId);
        return tier === "free" ? null : tier;
      },
    },
  ];

  for (const { source, run } of attempts) {
    try {
      tiers[source] = await run();
    } catch (err) {
      const message = asMessage(err);
      errors[source] = message;
      console.error(`[access] ${source} lookup failed for ${userId}: ${message}`);
    }
  }

  let winner: GrantSource | null = null;
  for (const source of RESOLUTION_ORDER) {
    const value = tiers[source];
    if (value === null) continue;
    if (winner === null || tierRank(value) > tierRank(tiers[winner])) winner = source;
  }

  const granted = winner === null ? null : tiers[winner];
  const allowed = granted !== null && tierRank(granted) > 0;

  return {
    allowed,
    source: allowed && winner ? winner : "none",
    tier: allowed && granted ? granted : "free",
    plan: planLabelFor(allowed && granted ? granted : "free"),
    instanceLimit: instanceLimitFor(allowed && granted ? granted : "free"),
    tiers,
    errors,
  };
}

/**
 * The tier to stamp onto a globe workspace.
 *
 * A hub-only tier (`beta_tester`, `early_access`) has no globe equivalent: the
 * globe's `/api/service/tier-sync` validates against free/pro/team/enterprise
 * and answers 400 for anything else, so pushing one would be a silent lie and a
 * failed write. For those, ask the globe what it already holds for the email
 * and keep it, so creating a workspace never DOWNGRADES a legacy customer. Only
 * when the globe cannot be read does this fall back to "free" - which is also
 * the globe's own default for an absent tier, so the workspace lock behaves
 * exactly as it did before this change.
 */
export async function toGlobeTier(tier: string, email: string): Promise<GlobeTier> {
  if (isGlobeTier(tier)) return tier;

  const read = await readGlobeTier(email);
  if (read.ok && isGlobeTier(read.state.tier)) return read.state.tier;

  console.warn(
    `[access] hub tier "${tier}" has no globe equivalent ` +
      `(${read.ok ? `globe holds "${read.state.tier}"` : read.failure}); stamping "free"`,
  );
  return "free";
}
