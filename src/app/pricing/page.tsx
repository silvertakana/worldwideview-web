import type { Metadata } from "next";
import PricingContent from "./PricingContent";

export const metadata: Metadata = { title: "Pricing" };

export default function PricingPage() {
  return <PricingContent />;
}
