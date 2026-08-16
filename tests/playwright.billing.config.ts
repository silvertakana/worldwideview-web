import { defineConfig, devices } from '@playwright/test';

/**
 * Billing E2E config — drives the RUNNING local stack (externally managed).
 *
 * MOVED from the globe repo (worldwideview.fix-billing-tier) — the hub now owns
 * billing (ADR-0009), so the suite + config live in this repo under tests/.
 *
 *   - hub   : https://hub.wwv.local            (caddy -> wwv-dev-hub container)
 *   - globe : http://localhost:3000            (wwv-dev-globe container)
 *   - db    : postgresql://postgres:postgres@127.0.0.1:5432/worldwideview
 *
 * baseURL is hub.wwv.local (NOT localhost:3001) because the hub sets its
 * Supabase session cookie with `domain: .wwv.local`; a cookie scoped to
 * .wwv.local is rejected by the browser when browsing plain localhost.
 *
 * The flow is serial (workers=1): the three tests share one seeded user,
 * one Stripe checkout session, and one subscription lifecycle.
 *
 * Paths below are relative to THIS file (tests/), so the Playwright artifacts
 * (storage state, output, html report) land at the repo root under playwright/.
 *
 * Run: pnpm test:e2e  (== playwright test --config=tests/playwright.billing.config.ts)
 *
 * WEBHOOK SIMULATOR NOTE: the test stack's simulator (test/simulator/) covers
 * only the SIGNATURE path. Tier-sync assertions in the specs need real Stripe
 * (or sandbox customers whose email the hub's webhook handler can resolve) —
 * see the billing-flow.spec.ts header. STRIPE_BASE_URL env override lets the
 * specs' direct Stripe REST calls point at stripe-mock instead.
 */
export default defineConfig({
  timeout: 120000,
  expect: {
    timeout: 30000,
  },
  globalSetup: './billing.global.setup.ts',
  globalTeardown: './billing.global.teardown.ts',
  testDir: './',
  testMatch: 'billing-*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  outputDir: '../playwright/output/billing',
  reporter: [
    ['list'],
    ['html', { outputFolder: '../playwright/report/billing', open: 'never' }],
  ],
  use: {
    baseURL: 'https://hub.wwv.local',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: '../playwright/.auth/billing-user.json',
      },
    },
  ],
  /* Servers are managed externally — do not auto-boot anything. */
  webServer: [],
});
