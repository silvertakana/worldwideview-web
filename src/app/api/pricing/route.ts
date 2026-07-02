import { NextResponse } from "next/server";

export interface PricingPlan {
  id: string;
  name: string;
  amount: number;
  interval: "month" | "year";
  features: string[];
  popular: boolean;
}

export async function GET() {
  const plans: PricingPlan[] = [
    {
      id: "pro-monthly",
      name: "Pro Monthly",
      amount: 1900,
      interval: "month",
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
      amount: 19000,
      interval: "year",
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
