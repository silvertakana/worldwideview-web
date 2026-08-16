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
}
