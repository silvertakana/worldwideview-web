#!/usr/bin/env node
/**
 * Read-only billing reconciliation runner.
 *
 * Compares Stripe against the hub's durable billing record (the
 * public.billing_subscriptions table) and exits non-zero when the two
 * disagree. Run by .github/workflows/billing-reconcile.yml on a schedule; the
 * exit code is what raises the alert.
 *
 * READ-ONLY EXCEPT FOR ONE DELIBERATE STEP. Every Stripe call is a GET and every
 * database statement is a SELECT. This script cannot cancel a subscription or
 * change a grant. The one thing it asks for is the globe's own tier-lock sweep
 * (scripts/lib/globe-tier-lock-sweep.mjs): a signed, bodiless POST telling the
 * globe to enforce the deadlines it has already armed on itself. It carries no
 * payload and names no account, so this runner decides nothing about who gets
 * locked.
 *
 * The comparison itself lives in scripts/lib/billing-reconcile-core.mjs and is
 * pure; this file is only the I/O around it.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { reconcile, isSweepEligible } from './lib/billing-reconcile-core.mjs'
import { requestTierLockSweep } from './lib/globe-tier-lock-sweep.mjs'

const STRIPE_API_DEFAULT = 'https://api.stripe.com/v1'
const REQUEST_TIMEOUT_MS = 30_000
const PAGE_LIMIT = '100'

/**
 * Every row, deliberately not just the non-canceled ones the app lists
 * (subscription-store.ts filters `status <> 'canceled'`). A ledger row that was
 * wrongly marked canceled must still match its live Stripe subscription:
 * filtered out, it would look like an unrecorded grant and the alert would be
 * a false one.
 */
const LEDGER_SQL = `
  SELECT user_id, email, stripe_customer_id, stripe_subscription_id,
         price_id, plan, interval, status, stripe_status,
         current_period_end, source
    FROM public.billing_subscriptions
   ORDER BY updated_at DESC
`

/**
 * @param {string[]} names env files, in increasing priority
 * @returns {Map<string,string>}
 */
function parseEnvFiles(names) {
  /** @type {Map<string,string>} */
  const values = new Map()
  for (const name of names) {
    let content
    try {
      content = fs.readFileSync(path.resolve(process.cwd(), name), 'utf8')
    } catch {
      continue // an absent env file is normal, and always the case in CI
    }
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([\w.-]+)\s*=(.*)$/)
      if (!match) continue
      let value = (match[2] || '').trim()
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
      if (value) values.set(match[1], value)
    }
  }
  return values
}

/**
 * Fill this runner's env contract from the repo's env files, the same
 * hand-rolled parse tests/lib/env.ts uses (no dotenv dependency). An
 * already-set variable always wins, so a developer's .env can never clobber
 * the CI secrets.
 *
 * The names are written out instead of looped: a computed key on process.env is
 * what eslint-plugin-security's object-injection rule forbids, and this list is
 * the runner's complete environment contract anyway.
 */
function loadEnvFiles() {
  const fromFile = parseEnvFiles(['.env', '.env.local'])
  const dbUrl = fromFile.get('SUPABASE_DB_URL')
  if (dbUrl && process.env.SUPABASE_DB_URL === undefined) process.env.SUPABASE_DB_URL = dbUrl
  const stripeKey = fromFile.get('STRIPE_SECRET_KEY')
  if (stripeKey && process.env.STRIPE_SECRET_KEY === undefined) process.env.STRIPE_SECRET_KEY = stripeKey
  const stripeBase = fromFile.get('STRIPE_BASE_URL')
  if (stripeBase && process.env.STRIPE_BASE_URL === undefined) process.env.STRIPE_BASE_URL = stripeBase
  const crossService = fromFile.get('CROSS_SERVICE_SECRET')
  if (crossService && process.env.CROSS_SERVICE_SECRET === undefined) process.env.CROSS_SERVICE_SECRET = crossService
  const provisioning = fromFile.get('PROVISIONING_API_URL')
  if (provisioning && process.env.PROVISIONING_API_URL === undefined) process.env.PROVISIONING_API_URL = provisioning
  // Deliberately the runner's own variable rather than PROVISIONING_API_URL:
  // that one is a deployment variable and is not guaranteed to exist on a
  // runner, and the sweep must never fall back to a guessed address.
  const globeUrl = fromFile.get('WWV_GLOBE_URL')
  if (globeUrl && process.env.WWV_GLOBE_URL === undefined) process.env.WWV_GLOBE_URL = globeUrl
}

/** pg hands back a Date for timestamptz; the core compares ISO instants. */
function toIso(value) {
  if (value instanceof Date) return value.toISOString()
  return typeof value === 'string' ? value : null
}

function normalizeLedgerRow(row) {
  return {
    user_id: row.user_id ?? null,
    email: row.email ?? null,
    stripe_customer_id: row.stripe_customer_id ?? null,
    stripe_subscription_id: row.stripe_subscription_id ?? null,
    price_id: row.price_id ?? null,
    plan: row.plan ?? null,
    interval: row.interval ?? null,
    status: row.status ?? null,
    stripe_status: row.stripe_status ?? null,
    current_period_end: toIso(row.current_period_end),
    source: row.source ?? 'stripe',
  }
}

/**
 * Read the ledger over Postgres. SUPABASE_DB_URL is the only credential that
 * reaches the hub database from a GitHub runner: there is no Supabase URL secret
 * and no service-role-key secret, and no environment-scoped secrets exist
 * either, so PostgREST and createAdminClient() are not available here.
 */
async function readLedger(dbUrl) {
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  try {
    const result = await pool.query(LEDGER_SQL)
    return result.rows.map(normalizeLedgerRow)
  } finally {
    await pool.end()
  }
}

/** One Stripe GET. Read-only: no other method is ever used. */
async function stripeGet(pathname, search, stripeKey, stripeBase) {
  const response = await fetch(`${stripeBase}${pathname}?${search.toString()}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${stripeKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `Stripe GET ${pathname} failed with HTTP ${response.status}: ${body.slice(0, 300)}`,
    )
  }
  return response.json()
}

/**
 * Walk a Stripe list endpoint to the end.
 *
 * Paginating is not optional: an unpaginated read reconciles the first page and
 * silently reports agreement about everything after it, which is worse than not
 * running at all. `has_more` plus `starting_after` is the same loop
 * tests/lib/stripe.ts uses.
 */
async function stripeListAll(pathname, params, stripeKey, stripeBase) {
  const collected = []
  let startingAfter
  for (;;) {
    const search = new URLSearchParams({ ...params, limit: PAGE_LIMIT })
    if (startingAfter) search.set('starting_after', startingAfter)
    const body = await stripeGet(pathname, search, stripeKey, stripeBase)
    const batch = Array.isArray(body.data) ? body.data : []
    collected.push(...batch)
    if (!body.has_more || batch.length === 0) break
    startingAfter = batch[batch.length - 1].id
  }
  return collected
}

/**
 * Stripe's view of every subscription, in the shape the pure core expects.
 * Customers are read first so each subscription can carry its account email,
 * which is the key the ledger is written against.
 */
async function readStripeSubscriptions(stripeKey, stripeBase) {
  const customers = await stripeListAll('/customers', {}, stripeKey, stripeBase)
  /** @type {Map<string,string|null>} */
  const emailByCustomerId = new Map()
  for (const customer of customers) {
    emailByCustomerId.set(customer.id, customer.email ?? null)
  }

  // status=all so a canceled subscription still matches its ledger row instead
  // of making that row look like a grant Stripe never backed.
  const subscriptions = await stripeListAll('/subscriptions', { status: 'all' }, stripeKey, stripeBase)

  return subscriptions.map((subscription) => {
    const item = Array.isArray(subscription.items?.data) ? subscription.items.data[0] : undefined
    const price = item?.price
    return {
      subscriptionId: subscription.id,
      customerId: subscription.customer ?? null,
      email: emailByCustomerId.get(subscription.customer) ?? null,
      status: subscription.status,
      priceId: price?.id ?? null,
      interval: price?.recurring?.interval ?? null,
      currentPeriodEnd: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : null,
    }
  })
}

function printReport(report, meta) {
  console.log('[reconcile] READ-ONLY run: nothing is written to Stripe, the hub database, or the globe.')
  console.log(`[reconcile] Stripe API base: ${meta.stripeBase}`)
  if (meta.stripeBase !== STRIPE_API_DEFAULT) {
    console.log('[reconcile] WARNING: STRIPE_BASE_URL is not the real Stripe API, so this run says nothing about production.')
  }
  console.log(`[reconcile] ledger rows read: ${meta.ledgerCount}`)
  console.log(`[reconcile] Stripe subscriptions read: ${meta.stripeCount}`)
  console.log(`[reconcile] evaluated at: ${report.evaluatedAt}`)

  // Object.entries, not counts[name]: a computed key on a record is a
  // security/detect-object-injection warning, and the report already carries
  // every class in DRIFT_CLASSES order.
  console.log('[reconcile] drift counts:')
  for (const [name, count] of Object.entries(report.counts)) {
    console.log(`[reconcile]   ${name}: ${count}`)
  }

  for (const item of report.drift) {
    console.log('')
    console.log(`  [${item.driftClass}] authority: ${item.authority}`)
    console.log(`    account: ${item.email ?? '(no email)'}`)
    console.log(`    subscription: ${item.subscriptionId ?? '(none)'}  customer: ${item.customerId ?? '(none)'}`)
    console.log(`    field: ${item.field}`)
    console.log(`    ledger says: ${JSON.stringify(item.ledgerValue)}`)
    console.log(`    Stripe says: ${JSON.stringify(item.stripeValue)}`)
    console.log(`    ${item.detail}`)
  }

  console.log('')
  console.log(`[reconcile] operator-owned rows (never reconciled): ${report.counts.operatorOwned}`)
  for (const owned of report.operatorOwned) {
    console.log(`    ${owned.email ?? '(no email)'}  subscription: ${owned.linkedStripeSubscriptionId ?? '(none)'}  active in Stripe: ${owned.activeInStripe}`)
  }
}

/** The only phase that leaves the read-only path, and only when drift demands it. */
async function runSweepPhase(sweepTargets) {
  const emails = [...new Set(sweepTargets.map((item) => item.email).filter(Boolean))]
  console.log('')
  console.log(`[reconcile] sweep phase: ${sweepTargets.length} drift item(s) say payment has stopped.`)
  console.log(`[reconcile] accounts affected: ${emails.join(', ') || '(no email on the drift items)'}`)
  const result = await requestTierLockSweep({ emails })
  console.log(
    `[reconcile] sweep finished in ${result.rounds} call(s): due=${result.due} locked=${result.locked}`,
  )
}

/**
 * Returns the exit code rather than setting one, so the whole runner is
 * drivable from a test instead of only from a shell.
 * @returns {Promise<number>} 0 when the two sides agree, 1 when they do not
 */
export async function main() {
  loadEnvFiles()

  const dbUrl = process.env.SUPABASE_DB_URL
  const stripeKey = process.env.STRIPE_SECRET_KEY
  if (!dbUrl) {
    throw new Error(
      'SUPABASE_DB_URL is not set. It is the only way this runner can read the hub database: ' +
        'there is no Supabase URL secret and no service-role-key secret. Set it in the workflow env, ' +
        'or export it locally.',
    )
  }
  if (!stripeKey) {
    throw new Error('STRIPE_SECRET_KEY is not set. Set it in the workflow env, or export it locally.')
  }
  const stripeBase = process.env.STRIPE_BASE_URL || STRIPE_API_DEFAULT

  const ledger = await readLedger(dbUrl)
  const stripeSubscriptions = await readStripeSubscriptions(stripeKey, stripeBase)
  const report = reconcile({ ledger, stripe: stripeSubscriptions })

  printReport(report, {
    stripeBase,
    ledgerCount: ledger.length,
    stripeCount: stripeSubscriptions.length,
  })

  const sweepTargets = report.drift.filter(isSweepEligible)
  if (sweepTargets.length > 0) {
    await runSweepPhase(sweepTargets)
  }

  if (report.ok) {
    console.log('')
    console.log('[reconcile] RESULT: no drift. The ledger and Stripe agree.')
    return 0
  }
  console.log('')
  console.log(`[reconcile] RESULT: DRIFT FOUND (${report.counts.total}). See docs/billing-reconciliation.md.`)
  return 1
}

// Run only when executed directly; importing this file (from the test) must not
// start a reconciliation.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error('')
    console.error(`[reconcile] FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
