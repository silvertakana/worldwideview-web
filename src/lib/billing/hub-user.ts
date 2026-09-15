import { createAdminClient } from "@/lib/supabase/admin";
import { asMessage } from "@/lib/billing/billing-tables";

/**
 * The hub's own user id, recovered from a candidate that came out of Stripe
 * metadata and PROVEN to exist before anyone stores it.
 *
 * Two different applications write `metadata.userId` into the same Stripe
 * account: the hub writes the Supabase uid
 * (src/app/api/billing/checkout/route.ts:90,101,104) and the marketplace writes
 * its own Prisma cuid. A candidate is therefore a hint, never an answer, and an
 * unvalidated hint is worse than none at all: storing a cuid in
 * billing_subscriptions.user_id attaches a paying customer's row to a user that
 * does not exist, and every downstream read (getSubscriptionForUser, the
 * reconciler's comparison, an operator asking "who is this?") silently returns
 * nothing. VALIDATED-OR-NULL is the rule. Email stays the real identity - the
 * table has UNIQUE(email) and the read policy matches on it.
 *
 * Why not resolve the id from the email instead: there is no getUserByEmail.
 * GoTrue's admin list endpoint filters only on page/per_page (verified against
 * the supabase/auth OpenAPI spec), the auth schema is not exposed to PostgREST
 * (supabase/config.toml `schemas = ["public", "graphql_public", "storage"]`), and
 * paging the entire user table on the payment path is not acceptable. getUserById
 * is O(1) and is the whole of what is needed here.
 */
export async function resolveVerifiedHubUserId(candidate?: string | null): Promise<string | null> {
  if (!candidate) return null;
  try {
    const { data, error } = await createAdminClient().auth.admin.getUserById(candidate);
    if (error || !data?.user) {
      console.warn(
        `[billing] Ignoring unusable stripe metadata.userId ${candidate}: ${error?.message ?? "no such user"}`,
      );
      return null;
    }
    return data.user.id;
  } catch (err) {
    console.warn(`[billing] Could not verify stripe metadata.userId ${candidate}: ${asMessage(err)}`);
    return null;
  }
}

/**
 * The first candidate that verifies, or null.
 *
 * Order is the caller's, and it matters: the hub's own metadata (the checkout
 * session and the subscription it creates) is tried before the Stripe customer
 * object's, because a customer record can be shared with the marketplace while
 * the hub's own session/subscription metadata is always the hub's.
 */
export async function firstVerifiedHubUserId(
  candidates: Array<string | null | undefined>,
): Promise<string | null> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const verified = await resolveVerifiedHubUserId(candidate);
    if (verified) return verified;
  }
  return null;
}
