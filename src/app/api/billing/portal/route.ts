import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe/client";

export async function POST(req: Request) {
  const stripe = getStripe();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!user.email) {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }

  // The Stripe calls below were unguarded: any Stripe API failure (rate limit,
  // invalid key, portal-session failure) escaped as Next.js's unhandled 500
  // with an empty body, which clients cannot read as JSON. The success branch
  // and the 404 guards return exactly what they returned before — only the
  // failure path gained a JSON response.
  try {
    // Resolve the customer by userId metadata first (same order as the tier
    // fallback), then by email. Email-first lands on the newest customer for
    // that address, which may be an orphan with no subscription.
    const byUserId = await stripe.customers.search({
      query: `metadata['userId']:'${user.id}'`,
      limit: 1,
    });
    let customer = byUserId.data[0];

    if (!customer) {
      const byEmail = await stripe.customers.list({ email: user.email, limit: 1 });
      customer = byEmail.data[0];
    }

    if (!customer) {
      return NextResponse.json(
        { error: "No Stripe customer found for this account" },
        { status: 404 },
      );
    }

    // Guard: only open the portal for a customer with a live subscription.
    // A customer with only canceled/expired subs must not get an empty portal
    // (no cancel button) - surface a clear message instead.
    const subs = await stripe.subscriptions.list({ customer: customer.id, limit: 5 });
    const hasLiveSubscription = subs.data.some((s) =>
      ["active", "trialing", "past_due"].includes(s.status),
    );

    if (!hasLiveSubscription) {
      return NextResponse.json(
        { error: "No active subscription" },
        { status: 404 },
      );
    }

    const origin = req.headers.get("origin") || "https://wwv.local";

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: `${origin}/accounts/billing`,
    });

    return NextResponse.json({ url: portalSession.url });
  } catch (err) {
    const stripeErr = stripeErrorOf(err);
    // Log type/code only: Stripe messages never contain secrets, but they are
    // not needed for observability and avoid leaking upstream detail text.
    console.error(
      `[billing] portal Stripe call failed - type=${stripeErr.type}${stripeErr.code ? ` code=${stripeErr.code}` : ""}${stripeErr.param ? ` param=${stripeErr.param}` : ""}`,
    );
    const body: {
      error: string;
      stripe_error: { type: string; code?: string; param?: string };
    } = {
      error: stripeErrorMessage(stripeErr.type),
      stripe_error: {
        type: stripeErr.type,
        ...(stripeErr.code !== undefined ? { code: stripeErr.code } : {}),
        ...(stripeErr.param !== undefined ? { param: stripeErr.param } : {}),
      },
    };
    return NextResponse.json(body, { status: stripeErrorStatus(stripeErr.type) });
  }
}

// Typed view of Stripe's error shape (node SDK classes expose type/code/param
// on StripeError subclasses). Structural, so no Stripe import is needed here.
interface StripeErrorLike {
  type?: unknown;
  code?: unknown;
  param?: unknown;
}

// Extract the Stripe wire-level error fields from a thrown error. Anything
// that does not look like a Stripe SDK error maps to a distinct sentinel so a
// plain internal bug reports 500 instead of pretending to know what Stripe said.
function stripeErrorOf(err: unknown): {
  type: string;
  code?: string;
  param?: string;
} {
  if (!(err instanceof Error)) return { type: "non_stripe_error" };
  const shaped = err as StripeErrorLike;
  if (typeof shaped.type !== "string") return { type: "non_stripe_error" };
  return {
    type: shaped.type,
    ...(typeof shaped.code === "string" ? { code: shaped.code } : {}),
    ...(typeof shaped.param === "string" ? { param: shaped.param } : {}),
  };
}

function stripeErrorStatus(type: string): number {
  if (type === "card_error") return 402;
  if (type === "rate_limit_error") return 429;
  if (type === "non_stripe_error") return 500;
  // Stripe-typed but server/config/transport related (api_error,
  // api_connection_error, invalid_request_error, authentication_error) are
  // not the client's doing: report like an upstream failure.
  return 502;
}

function stripeErrorMessage(type: string): string {
  if (type === "card_error") {
    return "Your payment method was declined. Please try another card or contact your bank.";
  }
  if (type === "rate_limit_error") {
    return "Billing is busy right now. Please try again in a moment.";
  }
  return "Could not open the billing portal. Please try again later.";
}
