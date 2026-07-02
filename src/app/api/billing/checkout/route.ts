import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe/client";
import { getPriceId } from "@/lib/billing/constants";
import type { PlanOption, IntervalOption } from "@/lib/billing/constants";

export async function POST(req: Request) {
  const stripe = getStripe();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { plan?: string; interval?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const plan = (body.plan || "pro") as PlanOption;
  if (plan !== "pro" && plan !== "team") {
    return NextResponse.json({ error: "Invalid plan. Must be 'pro' or 'team'" }, { status: 400 });
  }

  const interval = (body.interval || "month") as IntervalOption;
  if (interval !== "month" && interval !== "year") {
    return NextResponse.json({ error: "Invalid interval. Must be 'month' or 'year'" }, { status: 400 });
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
