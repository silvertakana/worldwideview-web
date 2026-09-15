import type { Metadata } from "next";
import { isBillingPaused } from "@/lib/billing/kill-switch";
import PricingContent from "./PricingContent";

export const metadata: Metadata = { title: "Pricing" };

export default async function PricingPage() {
  const { paused } = await isBillingPaused();
  return <PricingContent paused={paused} />;
}
