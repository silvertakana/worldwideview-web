import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe/client";
import { getPriceId, BILLING_PAUSED_MESSAGE } from "@/lib/billing/constants";
import type { PlanOption, IntervalOption } from "@/lib/billing/constants";
import { isBillingPaused } from "@/lib/billing/kill-switch";

// Accepted plan ids -> canonical (plan, interval) pair.
// The pricing page emits interval-encoded ids ("pro-monthly" / "pro-annual");
// the legacy ids ("pro" / "team") are kept for back-compat and take the
// optional `interval` body param (default "month").
const PLAN_ID_MAP: Record<string, { plan: PlanOption; interval: IntervalOption }> = {
  "pro": { plan: "pro", interval: "month" },
  "team": { plan: "team", interval: "month" },
  "pro-monthly": { plan: "pro", interval: "month" },
  "pro-annual": { plan: "pro", interval: "year" },
  "team-monthly": { plan: "team", interval: "month" },
  "team-annual": { plan: "team", interval: "year" },
};

export async function POST(req: Request) {
  // Runtime kill switch: stops NEW purchases only.
  // `/api/billing/webhook` is deliberately NOT gated — existing subscribers
  // keep their access and their billing stays correct while we are paused — and
  // `/api/billing/portal` is deliberately NOT gated — a customer must always be
  // able to cancel or update their card. The asymmetry is intentional.
  // This runs before getStripe(): while paused the Stripe client is never even
  // constructed, so no Stripe API call is possible.
  const killSwitch = await isBillingPaused();
  if (killSwitch.paused) {
    const body: {
      error: string;
      paused: true;
      source: string;
      reason?: string;
    } = {
      error: BILLING_PAUSED_MESSAGE,
      paused: true,
      source: killSwitch.source,
    };
    // `reason` is operator-supplied for "env"/"database" and absent for
    // "unavailable", so no internal failure text can ever leak to a client.
    // Assigned conditionally so the key is genuinely absent, not undefined.
    if (killSwitch.source !== "unavailable" && killSwitch.reason !== undefined) {
      body.reason = killSwitch.reason;
    }
    return NextResponse.json(body, { status: 503 });
  }

  const stripe = getStripe();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { plan?: string; interval?: string };
  try {
    const parsed: unknown = await req.json();
    // A bare POST (no body) from the UI must never 400/hang: default to Pro
    // (monthly). The shape guard also covers null/array/primitive JSON so a
    // malformed client cannot trigger a TypeError below. Explicit invalid
    // plans still 400 via the PLAN_ID_MAP check further down.
    body =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { plan?: string; interval?: string })
        : { plan: "pro" };
  } catch {
    // Empty or unparseable body -> default to Pro (monthly).
    body = { plan: "pro" };
  }

  const rawPlan = body.plan || "pro";
  const mappedPlan = PLAN_ID_MAP[rawPlan];
  if (!mappedPlan) {
    return NextResponse.json(
      {
        error:
          "Invalid plan. Must be one of: 'pro', 'team', 'pro-monthly', 'pro-annual', 'team-monthly', 'team-annual'",
      },
      { status: 400 },
    );
  }

  const plan = mappedPlan.plan;
  // Interval-encoded ids ("pro-monthly" etc.) win; legacy ids honor the
  // explicit `interval` body param (default "month").
  let interval = mappedPlan.interval;
  if (rawPlan === "pro" || rawPlan === "team") {
    const requested = (body.interval || "month") as IntervalOption;
    if (requested !== "month" && requested !== "year") {
      return NextResponse.json({ error: "Invalid interval. Must be 'month' or 'year'" }, { status: 400 });
    }
    interval = requested;
  }

  let priceId: string;
  try {
    priceId = getPriceId(plan, interval);
  } catch {
    return NextResponse.json(
      { error: `Plan not configured: ${plan}/${interval}` },
      { status: 500 },
    );
  }

  const origin = req.headers.get("origin") || "https://wwv.local";

  // The three Stripe calls below were unguarded: any Stripe API failure (rate
  // limit, invalid key, session-creation failure) escaped as Next.js's
  // unhandled 500 with an empty body, which clients cannot read as JSON. The
  // success branch returns exactly what it returned before — only the failure
  // path gained a JSON response.
  try {
    let customerId: string;
    const customers = await stripe.customers.search({
      query: `metadata['userId']:'${user.id}'`,
      limit: 1,
    });
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;
    } else {
      const customer = await stripe.customers.create({
        email: user.email || undefined,
        metadata: { userId: user.id },
      });
      customerId = customer.id;
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 7,
        metadata: { userId: user.id, plan, interval },
      },
      client_reference_id: user.id,
      metadata: { userId: user.id, plan, interval, email: user.email || "" },
      success_url: `${origin}/accounts/billing?status=success`,
      cancel_url: `${origin}/pricing?status=cancelled`,
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    const stripeErr = stripeErrorOf(err);
    // Log type/code only: Stripe messages never contain secrets, but they are
    // not needed for observability and avoid leaking upstream detail text.
    console.error(
      `[billing] checkout Stripe call failed - type=${stripeErr.type}${stripeErr.code ? ` code=${stripeErr.code}` : ""}${stripeErr.param ? ` param=${stripeErr.param}` : ""}`,
    );
    const body: {
      error: string;
      stripe_error: { type: string; code?: string; param?: string };
    } = {
      error: stripeErrorMessage(stripeErr.type, stripeErr.code),
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

function stripeErrorMessage(type: string, code: string | undefined): string {
  if (type === "card_error") {
    return "Your payment method was declined. Please try another card or contact your bank.";
  }
  if (type === "rate_limit_error") {
    return "Billing is busy right now. Please try again in a moment.";
  }
  return "Checkout could not be started. Please try again later.";
}
