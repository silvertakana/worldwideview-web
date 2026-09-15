# Signed-Webhook Simulator (test-only)

A small Node service that generates Stripe-shaped webhook events, signs them
**exactly as Stripe does**, and POSTs the raw body to the hub's
`/api/billing/webhook` endpoint. It exercises the real webhook handler
deterministically — offline, no Stripe network dependency.

## What it does

1. Loads a fixture from `events/` (a realistic Stripe event object).
2. Signs the raw JSON body exactly like Stripe: `t=<unix_ts>,v1=<hex HMAC-SHA256(ts + "." + body, webhook_secret)>` using Node's `crypto.createHmac`.
3. Validates the signature locally with the real Stripe SDK (`stripe.webhooks.constructEvent`) — the identical call the hub makes — proving the bytes are byte-identical to a real Stripe delivery.
4. POSTs the **raw body string** (not parsed JSON, matching the handler's `req.text()`) with a `stripe-signature` header to the target URL.
5. Prints the hub's HTTP status + body.

## How to run

From the hub repo root (`worldwideview-web.fix-billing`), with the hub dev
server running on port 3001:

```bash
node test/simulator/index.js checkout.session.completed
node test/simulator/index.js customer.subscription.created --email someone@example.com
node test/simulator/index.js customer.subscription.updated --status past_due
node test/simulator/index.js --matrix          # fire all 5 core event types
node test/simulator/index.js --list            # print the event catalog
node test/simulator/index.js <type> --self-test # validate signing, no POST
```

The webhook secret is read from `STRIPE_WEBHOOK_SECRET` (env) or the hub's
`.env.local`. It **must** be the same TEST secret the hub verifies with. The
script prints only the first 8 chars of the secret.

Target URL defaults to `http://localhost:3001/api/billing/webhook`; override
with `WEBHOOK_TARGET_URL`.

## CLI flags

| Flag | Effect |
|---|---|
| `--email <email>` | Override the customer email in the payload |
| `--price <price_id>` | Override the subscription price id |
| `--status <status>` | Override the subscription status (subscription events) |
| `--duplicate` | Deliver the identical signed body twice (replay test) |
| `--bad-signature` | Tamper the `v1` signature — hub must reply 400 |
| `--delay <ms>` | Wait before firing |
| `--self-test` | Validate the signature locally only, no POST |
| `--matrix` | Fire all core event types in sequence |

## Event catalog (`events/`)

| Fixture | Type | Purpose |
|---|---|---|
| `checkout.session.completed.json` | `checkout.session.completed` | New checkout → plan resolve + tier sync (trialing) |
| `customer.subscription.created.json` | `customer.subscription.created` | New subscription → tier sync with resolved status |
| `customer.subscription.updated.json` | `customer.subscription.updated` | Renewal/change → re-sync tier |
| `customer.subscription.deleted.json` | `customer.subscription.deleted` | Cancel → sync `free/canceled` |
| `invoice.payment_failed.json` | `invoice.payment_failed` | Dunning → sync `past_due` |
| `customer.subscription.updated.past_due.json` | `customer.subscription.updated` | Edge: status `past_due` mapping |
| `checkout.session.completed.no_email.json` | `checkout.session.completed` | Edge: missing email → handler warns and skips |

Price IDs used are the sandbox test prices (e.g. Pro monthly
`price_1TiVzJCnLxBZfLqIEC3gKEOi`), matching the hub's `.env.local`; canonical
defaults live in `src/lib/billing/constants.ts` (`DEFAULT_PRICE_IDS`); keep the
fixtures in sync when a price rotates.

## Security model

- **Test secret only.** The simulator reads the TEST webhook secret
  (`whsec_...` in the sandbox), never a production secret. Per-environment
  secrets mean a simulated (test-signed) event sent to a production hub fails
  verification — production only knows its own secret.
- **No bypass code.** The hub's handler verifies signatures with
  `stripe.webhooks.constructEvent` in every environment, including test. This
  simulator adds nothing to the hub — it only produces signatures the test
  secret accepts. There is no "if test then skip check" branch anywhere.
- **Proven byte-identical.** Every delivery is pre-validated locally through
  the real Stripe SDK before POSTing. If the signature did not match Stripe's
  format, the simulator aborts.
- **Test-only location.** Lives under `test/`, no `package.json`, no build
  wiring, never shipped to production.

## Notes / limitations

- The handler makes outbound Stripe API calls (`checkout.sessions.retrieve`,
  `customers.retrieve`). Without a stripe-mock service in the test stack,
  those calls fail against the real test API (nonexistent `cus_`/`cs_` ids).
  A throw during handling aborts the event before anything is processed: no
  provisioning, no tier sync. Under the fail-loud webhook contract the hub
  logs `[webhook] Handling FAILED ...`, records the failure against the event
  in the webhook ledger, and answers
  `500 { received: false, error: "Webhook handling failed" }` so Stripe
  redelivers and the redelivery is reprocessed (only a delivery that COMPLETED
  is absorbed as a duplicate). A hub that predates that contract swallows the
  throw and answers `{ received: true }` instead, which means the event was
  dropped rather than handled.
- So a `200 { received: true }` proves the signature path worked (a bad
  signature is a 400), but it is not proof that the event was processed: a
  globe-side tier-sync failure also answers 200, because that helper returns
  `{ ok: false }` instead of throwing.
- For tier-sync verification you need stripe-mock (separate concern) or real
  sandbox customers whose `email` resolves.
