export const BILLING_ENABLED = process.env.NEXT_PUBLIC_BILLING_ENABLED === "true";

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

/**
 * Canonical TEST-MODE Stripe price IDs (public `price_...` identifiers — safe
 * to commit). These are the real billing test-account prices from .env.local.
 *
 * Single source of truth: docker-compose.test.yml mirrors them as `${VAR:-default}`
 * compose defaults (YAML cannot import this module), and test specs derive their
 * fallback via getDefaultPriceId() instead of carrying their own literal. When a
 * price rotates, update ONLY this map + .env.local + the compose defaults.
 */
export const DEFAULT_PRICE_IDS: Readonly<
  Record<`${PlanOption}:${IntervalOption}`, string>
> = {
  "pro:month": "price_1TiVzJCnLxBZfLqIEC3gKEOi",
  "pro:year": "price_1TikxeCnLxBZfLqI06cRgceg",
  "team:month": "price_1TikxmCnLxBZfLqIHlviWvYg",
  "team:year": "price_1TikxqCnLxBZfLqINdd5I2xg",
};

/** Default price id for a plan/interval, used as the env-absent fallback. */
export function getDefaultPriceId(
  plan: PlanOption,
  interval: IntervalOption,
): string {
  return DEFAULT_PRICE_IDS[`${plan}:${interval}`];
}
