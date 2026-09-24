import { NextResponse } from "next/server";
import { PRICING_DISPLAY } from "@/lib/billing/constants";

/**
 * The machine-readable price list.
 *
 * NOTE: nothing in src/ calls this endpoint and no other repository references
 * it. It is kept honest rather than deleted, because a stale price list is worse
 * than no price list: whatever consumes it next would inherit the disagreement it
 * used to carry. The amounts and the currency now come from PRICING_DISPLAY, the
 * same table the pricing page renders, so the two cannot drift apart again.
 *
 * `currency` is part of the contract: without it a client can only guess what a
 * bare 1900 means, which is how a NZ$19 charge came to be advertised as "$19".
 */
export interface PricingPlan {
  id: string;
  name: string;
  amount: number;
  interval: "month" | "year";
  currency: string;
  features: string[];
  popular: boolean;
}

export async function GET() {
  const monthly = PRICING_DISPLAY.proMonthly;
  const annual = PRICING_DISPLAY.proAnnual;

  const plans: PricingPlan[] = [
    {
      id: "pro-monthly",
      name: "Pro Monthly",
      amount: monthly.amount,
      interval: "month",
      currency: monthly.currency,
      features: [
        "Cloud hosting",
        "Core plugins",
        "1 instance",
        "Google 3D Tiles",
        "Community support",
      ],
      popular: true,
    },
    {
      id: "pro-annual",
      name: "Pro Annual",
      amount: annual.amount,
      interval: "year",
      currency: annual.currency,
      features: [
        "Cloud hosting",
        "Core plugins",
        "1 instance",
        "Google 3D Tiles",
        "Community support",
        "2 months free",
      ],
      popular: false,
    },
  ];

  return NextResponse.json({ plans });
}
