// @ts-check
/**
 * Pure reconciliation core: compares the hub's durable billing ledger against
 * Stripe and classifies every disagreement.
 *
 * Contract: given two plain data sets this returns a report. No network, no
 * database, no filesystem, no clock beyond the one the caller injects. The
 * runner (scripts/billing-reconcile.mjs) does the I/O; correctness lives here
 * and is proven by billing-reconcile-core.test.ts.
 *
 * AUTHORITY. The two sides are not interchangeable, so every drift item names
 * the side whose data wins:
 *   - 'stripe'  payment facts (status, price, interval, billing period).
 *               Stripe knows whether they paid and for what.
 *   - 'ledger'  grant facts. This hub knows what it granted and never learns
 *               that from Stripe, so the reconciler reports and does not
 *               decide. Nothing here revokes a grant.
 * Collapsing those two into one notion of truth is the bug this file exists to
 * prevent, so no drift class omits its authority.
 */

/**
 * Stripe subscription status -> the hub's own status vocabulary. Mirrors
 * SUBSCRIPTION_STATUS_MAP in src/app/api/billing/webhook/route.ts: the
 * reconciler must judge disagreement in the vocabulary the webhook writes, or
 * every trialing subscription reads as drift. A Map rather than an object
 * because the key comes from Stripe and is looked up dynamically.
 * @type {Map<string, string>}
 */
export const STRIPE_STATUS_TO_HUB_STATUS = new Map([
  ['active', 'active'],
  ['past_due', 'past_due'],
  ['unpaid', 'suspended'],
  ['canceled', 'canceled'],
  ['incomplete', 'trialing'],
  ['incomplete_expired', 'canceled'],
  ['trialing', 'trialing'],
  ['paused', 'suspended'],
])

/**
 * Stripe statuses that mean the subscription is finished for good. Mirrors
 * TERMINAL_STATUSES in tests/lib/stripe.ts.
 * @type {ReadonlySet<string>}
 */
export const TERMINAL_STRIPE_STATUSES = new Set(['canceled', 'incomplete_expired'])

/**
 * Hub statuses that mean the workspace should not be open. Used only to decide
 * which drift items are worth handing to the globe's lock sweep.
 * @type {ReadonlySet<string>}
 */
const LAPSED_HUB_STATUSES = new Set(['canceled', 'suspended'])

/**
 * Payment-derived fields compared per matched pair. `plan` is deliberately
 * absent: this codebase derives plan from price (resolvePlanFromPriceId), so
 * price_id already covers a plan disagreement and comparing both would report
 * one disagreement twice.
 * @type {ReadonlyArray<{field: string, ledger: (row: LedgerRow) => unknown, stripe: (sub: StripeSubscription) => unknown}>}
 */
const PAYMENT_FIELDS = [
  { field: 'price_id', ledger: (row) => row.price_id ?? null, stripe: (sub) => sub.priceId ?? null },
  { field: 'interval', ledger: (row) => row.interval ?? null, stripe: (sub) => sub.interval ?? null },
]

/**
 * @typedef {Object} LedgerRow
 * @property {string|null} [user_id]
 * @property {string} [email]
 * @property {string|null} [stripe_customer_id]
 * @property {string|null} [stripe_subscription_id]
 * @property {string|null} [price_id]
 * @property {string|null} [plan]
 * @property {string|null} [interval]
 * @property {string} [status]
 * @property {string|null} [stripe_status]
 * @property {string|null} [current_period_end]
 * @property {'stripe'|'manual'} [source]
 *
 * @typedef {Object} StripeSubscription
 * @property {string} subscriptionId
 * @property {string|null} customerId
 * @property {string|null} [email]
 * @property {string} status
 * @property {string|null} [priceId]
 * @property {string|null} [interval]
 * @property {string|null} [currentPeriodEnd] ISO 8601
 *
 * @typedef {Object} DriftItem
 * @property {string} driftClass
 * @property {'stripe'|'ledger'} authority
 * @property {string} key           stable identity of the pair
 * @property {string|null} email
 * @property {string|null} subscriptionId
 * @property {string|null} customerId
 * @property {string} field         'row' for a whole-row gap, else a column name
 * @property {unknown} ledgerValue
 * @property {unknown} stripeValue
 * @property {string} detail        plain-language explanation for the operator
 *
 * @typedef {Object} OperatorOwnedRow
 * @property {string} key
 * @property {string|null} email
 * @property {string|null} userId
 * @property {string|null} subscriptionId
 * @property {string|null} customerId
 * @property {string|null} linkedStripeSubscriptionId
 * @property {boolean} activeInStripe
 * @property {string} reason
 */

/** Every drift class, in report order. Counts include zeros for all of them. */
export const DRIFT_CLASSES = [
  'missing_from_ledger',
  'missing_from_stripe',
  'status_mismatch',
  'plan_mismatch',
  'current_period_end_mismatch',
  'unknown_stripe_status',
]

/**
 * @param {string|number|null|undefined} value
 * @returns {number|null} epoch ms, or null when absent or unparseable
 */
function instant(value) {
  if (value === null || value === undefined || value === '') return null
  const ms = typeof value === 'number' ? value : Date.parse(String(value))
  return Number.isFinite(ms) ? ms : null
}

/**
 * Stable identity for a pair: the subscription, else the customer, else the email.
 * @param {{subscriptionId?: string|null, customerId?: string|null, email?: string|null}} ids
 */
function pairKey({ subscriptionId, customerId, email }) {
  return subscriptionId || customerId || email || '(unkeyed)'
}

/**
 * Claim key for a Stripe subscription. Stripe always supplies an id.
 * @param {StripeSubscription} sub
 */
function subKey(sub) {
  return sub.subscriptionId || `customer:${sub.customerId}`
}

/**
 * Compare the ledger's view against Stripe's view.
 * @param {{ledger?: LedgerRow[], stripe?: StripeSubscription[], now?: number}} input
 */
export function reconcile({ ledger = [], stripe = [], now = Date.now() } = {}) {
  /** @type {DriftItem[]} */
  const drift = []
  /** @type {OperatorOwnedRow[]} */
  const operatorOwned = []

  /** @type {Map<string, StripeSubscription>} */
  const bySubscriptionId = new Map()
  /** @type {Map<string, StripeSubscription>} */
  const byCustomerId = new Map()
  for (const sub of stripe) {
    if (sub.subscriptionId) bySubscriptionId.set(sub.subscriptionId, sub)
    if (sub.customerId && !byCustomerId.has(sub.customerId)) byCustomerId.set(sub.customerId, sub)
  }
  /** @type {Set<string>} */
  const claimed = new Set()

  for (const row of ledger) {
    const match =
      (row.stripe_subscription_id && bySubscriptionId.get(row.stripe_subscription_id)) ||
      (row.stripe_customer_id && byCustomerId.get(row.stripe_customer_id)) ||
      null
    if (match) claimed.add(subKey(match))

    const key = pairKey({
      subscriptionId: row.stripe_subscription_id,
      customerId: row.stripe_customer_id,
      email: row.email,
    })
    const where = { key, email: row.email ?? null }

    // Operator-owned rows are matched, so their Stripe subscription is not
    // reported as orphaned, but they are never compared and never appear in
    // drift: nothing in this report may propose a change to them.
    if (row.source === 'manual') {
      operatorOwned.push({
        ...where,
        userId: row.user_id ?? null,
        subscriptionId: row.stripe_subscription_id ?? null,
        customerId: row.stripe_customer_id ?? null,
        linkedStripeSubscriptionId: match ? match.subscriptionId ?? null : null,
        activeInStripe: match ? !TERMINAL_STRIPE_STATUSES.has(match.status) : false,
        reason: 'source=manual: operator-owned, not reconciled',
      })
      continue
    }

    if (!match) {
      drift.push({
        driftClass: 'missing_from_stripe',
        authority: 'ledger',
        ...where,
        subscriptionId: row.stripe_subscription_id ?? null,
        customerId: row.stripe_customer_id ?? null,
        field: 'row',
        ledgerValue: row.status ?? null,
        stripeValue: null,
        detail:
          `The ledger grants this account status '${row.status}', but Stripe holds no ` +
          `subscription for it. Whether the grant survives is this hub's call, not Stripe's.`,
      })
      continue
    }

    const shared = {
      ...where,
      subscriptionId: match.subscriptionId ?? null,
      customerId: match.customerId ?? null,
    }
    const mapped = STRIPE_STATUS_TO_HUB_STATUS.get(match.status)

    if (mapped === undefined) {
      drift.push({
        driftClass: 'unknown_stripe_status',
        authority: 'stripe',
        ...shared,
        field: 'status',
        ledgerValue: row.status ?? null,
        stripeValue: match.status,
        detail:
          `Stripe reports status '${match.status}', which this hub's status mapping does not ` +
          `cover. A payment state we cannot name is a payment state we cannot enforce.`,
      })
    } else if (mapped !== (row.status ?? null)) {
      drift.push({
        driftClass: 'status_mismatch',
        authority: 'stripe',
        ...shared,
        field: 'status',
        ledgerValue: row.status ?? null,
        stripeValue: mapped,
        detail:
          `The ledger says '${row.status}', Stripe says '${mapped}' ` +
          `(raw Stripe status '${match.status}'). Payment state is Stripe's to report.`,
      })
    }

    const stripeEnd = instant(match.currentPeriodEnd)
    if (stripeEnd !== null && stripeEnd !== instant(row.current_period_end)) {
      drift.push({
        driftClass: 'current_period_end_mismatch',
        authority: 'stripe',
        ...shared,
        field: 'current_period_end',
        ledgerValue: row.current_period_end ?? null,
        stripeValue: match.currentPeriodEnd ?? null,
        detail:
          'The paid-through date on the ledger differs from the one Stripe reports. ' +
          'The billing period is Stripe\'s to report.',
      })
    }

    for (const check of PAYMENT_FIELDS) {
      const stripeValue = check.stripe(match)
      if (stripeValue === null || stripeValue === undefined) continue
      const ledgerValue = check.ledger(row)
      if (ledgerValue !== stripeValue) {
        drift.push({
          driftClass: 'plan_mismatch',
          authority: 'stripe',
          ...shared,
          field: check.field,
          ledgerValue,
          stripeValue,
          detail:
            `The ledger records ${check.field} '${ledgerValue}', Stripe records ` +
            `'${stripeValue}'. What they are paying for is Stripe's to report.`,
        })
      }
    }
  }

  // Orphaned Stripe subscriptions: a live paid relationship this hub never
  // recorded. Terminal ones are history, so they are not worth an alert.
  for (const sub of stripe) {
    if (claimed.has(subKey(sub))) continue
    if (TERMINAL_STRIPE_STATUSES.has(sub.status)) continue
    drift.push({
      driftClass: 'missing_from_ledger',
      authority: 'stripe',
      key: pairKey({ subscriptionId: sub.subscriptionId, customerId: sub.customerId, email: sub.email }),
      email: sub.email ?? null,
      subscriptionId: sub.subscriptionId ?? null,
      customerId: sub.customerId ?? null,
      field: 'row',
      ledgerValue: null,
      stripeValue: sub.status,
      detail:
        `Stripe holds a live subscription (status '${sub.status}') that the ledger does not ` +
        `record at all. Stripe is the authority that they paid; the grant was never written down.`,
    })
  }

  drift.sort(
    (a, b) =>
      a.driftClass.localeCompare(b.driftClass) ||
      a.key.localeCompare(b.key) ||
      a.field.localeCompare(b.field),
  )

  /** @type {Map<string, number>} */
  const tally = new Map()
  for (const item of drift) {
    tally.set(item.driftClass, (tally.get(item.driftClass) ?? 0) + 1)
  }

  // Object.assign rather than a spread: spreading a string-keyed record into the
  // report literal drops its index signature, which would silently erase every
  // per-class count from the type.
  const counts = Object.assign(
    Object.fromEntries(
      DRIFT_CLASSES.map((name) => /** @type {[string, number]} */ ([name, tally.get(name) ?? 0])),
    ),
    { total: drift.length, operatorOwned: operatorOwned.length },
  )

  return {
    ok: drift.length === 0,
    evaluatedAt: new Date(now).toISOString(),
    counts,
    drift,
    operatorOwned,
  }
}

/**
 * Whether a drift item is one the globe's lock sweep would care about: a grant
 * Stripe no longer backs, or a status that has lapsed. Everything else is
 * reported but never acted on.
 * @param {DriftItem} item
 */
export function isSweepEligible(item) {
  if (item.driftClass === 'missing_from_stripe') return true
  if (item.driftClass === 'status_mismatch') return LAPSED_HUB_STATUSES.has(String(item.stripeValue))
  return false
}
