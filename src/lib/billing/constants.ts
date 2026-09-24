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
  const entry = PRICE_ID_MAP.find((e) => e.priceId === priceId);
  if (entry && entry.priceId) {
    return entry;
  }
  for (const [key, defaultId] of Object.entries(DEFAULT_PRICE_IDS)) {
    if (defaultId === priceId) {
      const [plan, interval] = key.split(":") as [PlanOption, IntervalOption];
      return { plan, interval, priceId };
    }
  }
  return null;
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

/* ─────────────────────── what the customer is shown ─────────────────────── */

/**
 * A price as the customer reads it. Amounts are in the currency's SMALLEST UNIT
 * (cents), which is what Stripe's API uses and therefore what the checkout is
 * actually built from, and `currency` is stated explicitly rather than implied by
 * a bare "$".
 *
 * WHY THIS IS NOT THE `PricingPlan` INTERFACE ABOVE. That one binds a hub plan to
 * a Stripe price ID and carries marketing fields (features, popular); this one is
 * only the number and the currency a page renders. The two do not have the same
 * input, so folding them together would mean the pricing page's client component
 * importing a price-ID lookup that THROWS when the env var is unset.
 *
 * WHY THERE IS ONE TABLE. These numbers used to be written down three times -
 * PricingContent.tsx, PlanPicker.tsx and api/pricing/route.ts - and could
 * therefore disagree. They did: the page rendered a bare "$19" while Stripe
 * Checkout, on a NZ account, charged NZ$19. One table, read by all three.
 */
export interface DisplayPrice {
  /** The price in the currency's smallest unit. Stripe's `unit_amount`. */
  amount: number;
  /** ISO-4217 code, so a bare symbol can never be the only currency evidence. */
  currency: string;
  /** Absent for a plan that has no billing interval. */
  interval?: IntervalOption;
}

/**
 * The hub's advertised prices. Keep in step with the Stripe prices the checkout
 * route resolves: these are display and API values, and Stripe remains the
 * authority for what is actually charged.
 */
export const PRICING_DISPLAY: Record<"local" | "proMonthly" | "proAnnual", DisplayPrice> = {
  local: { amount: 0, currency: "USD" },
  proMonthly: { amount: 1900, currency: "USD", interval: "month" },
  proAnnual: { amount: 19000, currency: "USD", interval: "year" },
};

/**
 * Currency symbols, for display only.
 *
 * Deliberately NOT Intl.NumberFormat: the pricing page is a client component that
 * the server renders first, and ICU's currency symbol and spacing differ between
 * Node and the browser - which would turn a price into a hydration mismatch. The
 * hub prices one currency, so the symbol is a constant. A currency with no entry
 * falls back to its ISO code: ugly, but never WRONG, whereas a bare "$" is wrong
 * for every currency except the one it happens to denote.
 */
const CURRENCY_SYMBOLS: Record<string, string> = { USD: "US$" };

/** Reads as "US$19" for (1900, "USD"). */
export function formatPrice(amount: number, currency: string): string {
  // Uppercased here, not by the caller. Stripe returns currency codes lowercased
  // ("usd"), and a lookup that missed would fall back to printing "usd 19" - a
  // wrong label produced silently, which is the exact class of bug this table
  // exists to remove. Normalising in one place makes every caller correct.
  const code = currency.toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code] ?? `${code} `;
  const whole = amount / 100;
  return `${symbol}${Number.isInteger(whole) ? whole : whole.toFixed(2)}`;
}

/**
 * Customer-facing copy for the runtime kill switch (src/lib/billing/kill-switch.ts).
 *
 * It lives HERE, not there, because that module imports the service-role admin
 * client, which is `server-only`: a client component can never import the switch
 * itself, but it does need this string.
 */
export const BILLING_PAUSED_MESSAGE = "Billing is temporarily unavailable. Please try again later.";
