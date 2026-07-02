export type PlanOption = "pro" | "team";
export type IntervalOption = "month" | "year";

export interface PriceEntry {
  plan: PlanOption;
  interval: IntervalOption;
  priceId: string;
}

export interface PricingPlan {
  id: string;
  name: string;
  priceId: string;
  amount: number;
  interval: IntervalOption;
  currency: string;
  features: string[];
  popular: boolean;
}

const ENV_KEY_MAP: Record<string, string> = {
  "pro:month": "STRIPE_PRO_PRICE_ID",
  "pro:year": "STRIPE_PRO_ANNUAL_PRICE_ID",
  "team:month": "STRIPE_TEAM_MONTHLY_PRICE_ID",
  "team:year": "STRIPE_TEAM_ANNUAL_PRICE_ID",
};

function envKeyFor(plan: PlanOption, interval: IntervalOption): string {
  return ENV_KEY_MAP[`${plan}:${interval}`];
}

const BASE_ENTRIES = [
  { plan: "pro" as const, interval: "month" as const },
  { plan: "pro" as const, interval: "year" as const },
  { plan: "team" as const, interval: "month" as const },
  { plan: "team" as const, interval: "year" as const },
];

export const PRICE_ID_MAP: PriceEntry[] = BASE_ENTRIES.map((entry) => ({
  ...entry,
  priceId: process.env[envKeyFor(entry.plan, entry.interval)] ?? "",
}));

export function getPriceId(plan: PlanOption, interval: IntervalOption): string {
  const entry = PRICE_ID_MAP.find(
    (e) => e.plan === plan && e.interval === interval,
  );
  if (!entry || !entry.priceId) {
    const key = envKeyFor(plan, interval);
    throw new Error(
      `Price ID not configured for ${plan}/${interval}. ` +
        `Set ${key} in your environment.`,
    );
  }
  return entry.priceId;
}

export function resolvePlanFromPriceId(priceId: string): PriceEntry | null {
  return PRICE_ID_MAP.find((entry) => entry.priceId === priceId) ?? null;
}
