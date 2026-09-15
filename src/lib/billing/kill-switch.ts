/**
 * The RUNTIME billing kill switch: one switch that stops NEW purchases without
 * a rebuild, a redeploy, or (via the env backstop) any database access at all.
 *
 * WHY THIS EXISTS. The only switch the hub had was the build-time
 * `NEXT_PUBLIC_BILLING_ENABLED` in constants.ts. Next inlines `NEXT_PUBLIC_*`
 * into the bundle when it builds, so flipping that one means a full rebuild and
 * redeploy - minutes of work for a decision that has to take effect now - and
 * it reaches nothing that reads its environment at request time: the webhook
 * and tier-sync paths never consult it. This module is read PER REQUEST
 * instead, and the normal operator path is a row in `billing_control`
 * (supabase/migrations/20260915170000_create_billing_control.sql), so the
 * decision is durable, carries an operator reason, and leaves an audit trail.
 *
 * TWO SOURCES, ONE ORDER. `BILLING_KILL_SWITCH` is read first, synchronously,
 * on EVERY call, and wins over the database. It is the backstop: it works with
 * the database unreachable or unmigrated, and because it is never cached, an
 * operator who sets it takes effect on the very next request. The database row
 * is the normal path - it is the one that can carry a reason - and its answer
 * is cached in-process for KILL_SWITCH_CACHE_TTL_MS so the checkout path does
 * not pay a round-trip per request. Only the database answer is cached; caching
 * the env answer would put a delay on the one switch meant to be instant.
 *
 * FAIL CLOSED. Anything that leaves the state unknown - a thrown client (a
 * missing SUPABASE_SERVICE_ROLE_KEY is a throw, not a result), a Supabase
 * `error` object, a network failure, or no row at all - answers
 * `{ paused: true, source: "unavailable" }`. A missing row is an unknown state
 * exactly like an unreadable one, so it is not read as "not paused". On an
 * unknown state the customer-safe direction is to stop NEW purchases: nobody is
 * wrongly charged and no existing subscriber loses anything, and the refusal is
 * LOUD in the log rather than silently permissive. That branch carries no
 * `reason`, so an internal failure can never leak a connection string or SQL
 * into a 503 body.
 *
 * WHAT IT DOES NOT GATE, ON PURPOSE - the switch is asymmetric by design:
 *   - /api/billing/webhook is NEVER gated. Existing subscribers keep the access
 *     they paid for, and Stripe keeps delivering renewals, cancellations and
 *     payment failures while sales are paused, so the durable record stays
 *     correct and a resume never has to replay an outage.
 *   - /api/billing/portal is NEVER gated. A customer must always be able to
 *     cancel or update their card; blocking the portal would trap people in a
 *     subscription they are trying to leave.
 *   - /api/billing/checkout IS gated - that is the whole point: new purchases.
 *
 * Never throws: every path is wrapped, because a checkout caller needs a state,
 * not an exception. invalidateBillingKillSwitchCache() drops the cached
 * database answer; the admin action that flips the row calls it so the operator
 * sees their own change immediately instead of up to one TTL later.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { asMessage } from "@/lib/billing/billing-tables";

export type KillSwitchSource = "env" | "database" | "unavailable";

export interface BillingKillSwitchState {
  paused: boolean;
  source: KillSwitchSource;
  /** Operator-supplied reason. ABSENT when source === "unavailable" (never leaks internals). */
  reason?: string;
}

export const KILL_SWITCH_CACHE_TTL_MS = 10_000;

/** The env values that mean paused, compared case-insensitively after trimming. */
const PAUSED_VALUES = new Set(["true", "1", "yes"]);

/** Fixed operator copy: the env var has no row to carry a reason. */
const ENV_REASON = "Billing is paused by the BILLING_KILL_SWITCH environment variable.";

/** Cached DATABASE answer and the moment it stops being usable. The env check
 *  is deliberately outside this cache - see the docblock. */
let cachedState: BillingKillSwitchState | null = null;
let cacheExpiresAt = 0;

/** Drops the cached database answer. Called by the admin action and by tests. */
export function invalidateBillingKillSwitchCache(): void {
  cachedState = null;
  cacheExpiresAt = 0;
}

/**
 * The state of NEW purchases. Safe on an unauthenticated path: it never throws
 * and only ever returns a reason an operator supplied.
 */
export async function isBillingPaused(): Promise<BillingKillSwitchState> {
  if (envPaused()) {
    return { paused: true, source: "env", reason: ENV_REASON };
  }
  if (cachedState !== null && Date.now() < cacheExpiresAt) {
    return cachedState;
  }
  const state = await readDatabase();
  // The failure answer is cached too: an outage must not be amplified into one
  // query and one log line per checkout request, and recovery is visible within
  // one TTL.
  cachedState = state;
  cacheExpiresAt = Date.now() + KILL_SWITCH_CACHE_TTL_MS;
  return state;
}

function envPaused(): boolean {
  const raw = process.env.BILLING_KILL_SWITCH;
  return raw !== undefined && PAUSED_VALUES.has(raw.trim().toLowerCase());
}

/** Never throws: every failure below becomes an `unavailable` state, loudly. */
async function readDatabase(): Promise<BillingKillSwitchState> {
  try {
    const { data, error } = await createAdminClient()
      .from("billing_control")
      .select("billing_paused, reason")
      .limit(1)
      .maybeSingle();

    if (error) {
      return fail(error.message);
    }

    const row = data as { billing_paused: boolean | null; reason: string | null } | null;
    if (!row) {
      return fail("billing_control has no row");
    }
    if (row.billing_paused === true) {
      const reason = row.reason ?? null;
      // Omitting the key (rather than emitting `reason: null`) is what keeps an
      // absent reason distinguishable from an internal failure downstream.
      return reason === null
        ? { paused: true, source: "database" }
        : { paused: true, source: "database", reason };
    }
    if (row.billing_paused === false) {
      return { paused: false, source: "database" };
    }
    // A column that is neither true nor false is unknown, not a licence to sell.
    return fail("billing_control.billing_paused is not a boolean");
  } catch (err) {
    return fail(asMessage(err));
  }
}

function fail(detail: string): BillingKillSwitchState {
  console.error(`[billing] kill-switch database read failed: ${detail}`);
  return { paused: true, source: "unavailable" };
}
