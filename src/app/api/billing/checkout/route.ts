import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe/client";
import { getPriceId } from "@/lib/billing/constants";
import type { PlanOption, IntervalOption } from "@/lib/billing/constants";

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
}
