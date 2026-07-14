---
status: investigating
trigger: "The redesigned pricing page replaced the old plan selection UI with the production design, but lost the plan comparison/picking functionality."
created: 2026-06-20T23:35:00+10:00
updated: 2026-06-20T23:35:00+10:00
---

## Current Focus

hypothesis: The PricingClient.tsx component (plan picker with interval toggle, seat selector, subscribe flow) and its CSS were deleted when PricingContent.tsx was repurposed as the main component.
test: Compare git files at 5b10f90 vs HEAD to catalog all deletions
expecting: Confirmed — PricingClient.tsx deleted, CSS reduced from ~300 lines to ~49 lines, page.tsx changed from API-driven to static
next_action: compile full findings and report

## Symptoms

expected: Pricing page has production design (glow effects, tier cards, responsive grid) AND plan picking functionality (interval toggle, seat selector, subscribe flow, dynamic pricing)
actual: Only production design remains. No interval toggle, no seat selector, no subscribe via /api/billing/checkout, no dynamic pricing from /api/pricing. CTA buttons are static links.
errors: None — functionality silently removed
reproduction: Visit /pricing on main branch — only 2 static tiers with hardcoded CTAs
started: Broke between commit 5b10f90 and d5d1d84 (the "type-safe plans array" and subsequent commits)

## Eliminated

- hypothesis: The backend APIs are also missing
  evidence: /api/pricing, /api/billing/checkout, /api/billing/account all still exist and work
  timestamp: 2026-06-20T23:35:00+10:00

## Evidence

- timestamp: 2026-06-20T23:35:00+10:00
  checked: git ls-tree 5b10f90 src/app/pricing/
  found: 4 files existed: PricingClient.tsx, PricingContent.tsx, page.module.css, page.tsx
  implication: PricingClient.tsx was deleted in the redesign

- timestamp: 2026-06-20T23:35:00+10:00
  checked: current glob src/app/pricing/**
  found: Only 3 files: PricingContent.tsx, page.module.css, page.tsx
  implication: PricingClient.tsx is confirmed deleted

- timestamp: 2026-06-20T23:35:00+10:00
  checked: git show 5b10f90:src/app/pricing/PricingClient.tsx
  found: Full plan picker component: interval toggle (Monthly/Annual with 20% savings badge), 3 tier cards (Free/Pro/Team), seat selector for Team plan, subscribe flow via POST /api/billing/checkout, login prompt for unauthenticated users, error/success states, dynamic prices from /api/pricing
  implication: All plan picking functionality was in this deleted file

- timestamp: 2026-06-20T23:35:00+10:00
  checked: git show 5b10f90:src/app/pricing/page.module.css (old) vs current page.module.css
  found: Old CSS had ~300 lines with toggle, cardGrid, card, cardPopular, popularBadge, cardName, cardPrice, cardInterval, cardPriceNote, seatSelector, seatLabel, seatButton, seatCount, cardFeatures, cardFeatureItem, ctaButton, ctaButtonTeam, ctaButtonDisabled, stateContainer, stateText, retryButton, subscribeError, loginPrompt, loginLink styles. Current CSS has ~49 lines with only marketing styles (glow, tier, hero, enterprise, features).
  implication: All plan picker CSS was removed from page.module.css

- timestamp: 2026-06-20T23:35:00+10:00
  checked: git show 5b10f90:src/app/pricing/page.tsx (old) vs HEAD page.tsx
  found: Old page.tsx fetched live plans from /api/pricing with cache:no-store, passed plans+userId+userEmail to PricingClient. Current page.tsx just renders PricingContent with no API fetch.
  implication: Dynamic pricing data flow was severed

- timestamp: 2026-06-20T23:35:00+10:00
  checked: /api/pricing/route.ts, /api/billing/checkout/route.ts, /api/billing/account/route.ts
  found: All backend routes intact. /api/pricing returns PricingPlan[] with live Stripe amounts. /api/billing/checkout creates Stripe checkout sessions. /api/billing/account returns plan status via cross-service fetch.
  implication: Backend is ready — frontend just needs to call it again

## Resolution

root_cause: The redesign deleted PricingClient.tsx (plan picker), removed all plan picker CSS from page.module.css, and changed page.tsx from API-driven to static rendering. The production design (PricingContent.tsx) was kept and enhanced with auth-aware CTAs, but the plan picking/selection UX was lost.
fix: Restore plan picking functionality by creating a new client component that combines the production design styling with the plan picking logic, or restore PricingClient.tsx with updated CSS.
verification: (pending)
files_changed: []
