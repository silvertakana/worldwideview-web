import { NextResponse } from "next/server";
import type Stripe from "stripe";
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

// The metadata tag the thank-you buyers were created with by hand in the Stripe
// dashboard. Used twice below - to pick the right customer record, and to decide
// whether the session gets a trial - so it lives in one place.
const THANKYOU_COHORT = "early-access-thankyou";

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
    // The customer this session bills, and the one whose metadata below decides
    // whether the thank-you cohort path applies. Both lookups return a whole
    // Customer, so the metadata costs no extra call.
    let foundCustomer: Stripe.Customer | null = null;

    const customers = await stripe.customers.search({
      query: `metadata['userId']:'${user.id}'`,
      limit: 1,
    });
    if (customers.data.length > 0) {
      foundCustomer = customers.data[0];
    } else if (user.email) {
      // The early-access buyers were created by hand in the Stripe dashboard and
      // carry no userId, so the metadata search above always misses them and this
      // route used to mint a SECOND customer for the same person. A
      // customer-restricted promo code is then rejected with
      // promotion_code_customer_mismatch (400), so their personal code could not
      // be redeemed even with a code field on the checkout page. Matching on the
      // account email is what makes those codes reachable.
      //
      // customers.list, not the search API: the search index lags writes by
      // seconds, and this path runs the moment a buyer signs up, which is exactly
      // when a just-written record is most likely to be missing from it. A
      // lookup that fails intermittently here reads as a random bug.
      //
      // limit is deliberately more than 1. customers.list is newest-first, and a
      // buyer who tried to check out before this fix owns a second, empty
      // customer record created by the old code: taking data[0] would pick the
      // empty one and the restricted code would be refused again - the same
      // failure, wearing a disguise.
      const byEmail = await stripe.customers.list({ email: user.email, limit: 10 });
      // Prefer the record that names the cohort; otherwise take the newest.
      const matched =
        byEmail.data.find((c) => c.metadata?.wwv_cohort === THANKYOU_COHORT) ?? byEmail.data[0];
      if (matched) {
        foundCustomer = matched;
        if (matched.metadata?.userId !== user.id) {
          // Adopt it, so the next checkout hits on userId and this stops being a
          // fallback. Awaited rather than fired and forgotten: if adopting fails
          // the checkout fails, which is the right way round - the alternative is
          // quietly minting a duplicate customer and handing the buyer a code
          // Stripe will reject.
          //
          // The existing metadata is spread back in deliberately: these customers
          // carry the cohort tags (wwv_cohort, wwv_first_name, wwv_ticket), and a
          // metadata update replaces the object, so dropping them would both
          // destroy the record and disable the cohort path below.
          await stripe.customers.update(matched.id, {
            metadata: { ...matched.metadata, userId: user.id },
          });
        }
      }
    }

    if (foundCustomer) {
      customerId = foundCustomer.id;
    } else {
      const customer = await stripe.customers.create({
        email: user.email || undefined,
        metadata: { userId: user.id },
      });
      customerId = customer.id;
      foundCustomer = customer;
    }

    // "One month free" is the coupon's job, and only the coupon's job. Stacking a
    // 7-day trial on top of a duration:once 100%-off coupon is what makes the
    // free period long rather than a month: either Stripe spends the coupon on
    // the trial's zero-amount invoice and the buyer is charged at day 8, or the
    // trial runs first and the first real charge lands around day 38. Neither is
    // the day 31 the offer promises. Suppressing the trial for this cohort is
    // what makes the free month exactly a month and the charge date exactly day
    // 31 - the sequence stripe-ops already proved in live mode: coupon applied,
    // amount_total 0 today, US$19.00/month from day 30.
    //
    // Everyone else keeps the 7-day trial; this is not a change to the public
    // offer. The cohort case that is NOT handled: a buyer who signs up with a
    // different address than their code was restricted to matches no record, so
    // this branch never runs and Stripe refuses the code. That refusal is
    // fail-closed and visible - the code is rejected, nobody is charged full
    // price - and it is recoverable by hand from the dashboard.
    const isThankyouCohort = foundCustomer?.metadata?.wwv_cohort === THANKYOU_COHORT;

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      // Puts the "Add promotion code" box on the hosted page. Without it a buyer
      // has nowhere to type a personal code, which is the other half of why the
      // hand-built promo codes were unreachable.
      //
      // THE PROTECTION IS IN THE CODE, NOT THE COUPON. Coupon THANKYOU-FIRSTMONTH
      // is unrestricted - a coupon has no customer field - so applying it
      // directly would give every stranger a free month, with the UI still
      // looking right and every test still passing. What limits it to one person
      // is the promotion code's customer restriction, which only exists because
      // the buyer types the code string here. Replacing this line with
      // `discounts: [{ coupon: ... }]` would silently remove that limit.
      //
      // Mutually exclusive with a `discounts` array; this route passes neither
      // `discounts` nor the deprecated `discount`.
      allow_promotion_codes: true,
      subscription_data: {
        ...(isThankyouCohort ? {} : { trial_period_days: 7 }),
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
