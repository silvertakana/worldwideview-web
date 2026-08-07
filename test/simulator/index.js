#!/usr/bin/env node
/**
 * WWV Hub signed-webhook simulator (TEST-ONLY).
 *
 * Generates Stripe-shaped webhook events, signs them exactly as Stripe does
 * (t=<ts>,v1=<HMAC-SHA256(ts + "." + raw_payload, webhook_secret)>) and POSTs
 * the RAW body bytes to the hub's /api/billing/webhook endpoint. The hub
 * verifies the signature with stripe.webhooks.constructEvent - the same code
 * path a real Stripe delivery uses - so this exercises the real handler
 * deterministically, offline, with no Stripe network dependency.
 *
 * SECURITY MODEL:
 *  - Uses the TEST webhook secret (STRIPE_WEBHOOK_SECRET from env or the
 *    hub's .env.local). Never a production secret.
 *  - Adds NO bypass code to the hub: the handler's constructEvent call is the
 *    same one used in production. This simulator just produces signatures the
 *    test secret accepts.
 *  - The signature is validated locally with the real Stripe SDK
 *    (stripe.webhooks.constructEvent) before every POST, proving the bytes
 *    are byte-identical to what Stripe would deliver.
 *
 * USAGE:
 *   node test/simulator/index.js <event-type> [flags]
 *   node test/simulator/index.js --matrix
 *   node test/simulator/index.js --list
 *
 * Event types (see events/):
 *   checkout.session.completed | customer.subscription.created
 *   customer.subscription.updated | customer.subscription.deleted
 *   invoice.payment_failed
 *
 * Flags:
 *   --email <email>       override the customer email in the payload
 *   --price <price_id>    override the subscription price id
 *   --status <status>     override subscription status (subscription events)
 *   --duplicate           deliver the exact same signed body twice (replay)
 *   --bad-signature       tamper the signature (hub must reply 400)
 *   --delay <ms>          wait before firing
 *   --self-test           validate the signature locally, do NOT POST
 *   --list                print the event catalog and exit
 *
 * Env:
 *   WEBHOOK_TARGET_URL    default http://localhost:3001/api/billing/webhook
 *   STRIPE_WEBHOOK_SECRET default read from the hub's .env.local
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const EVENTS_DIR = path.join(__dirname, "events");
const DEFAULT_TARGET = "http://localhost:3001/api/billing/webhook";
const SECRET_REDACT_KEEP = 8; // never print more than the first 8 chars

// ---------------------------------------------------------------------------
// env loading: process.env first, then the hub's .env.local as fallback
// ---------------------------------------------------------------------------
function loadEnv() {
  const vars = { ...process.env };
  const envPath = path.join(__dirname, "..", "..", ".env.local");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in vars)) {
        vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
  return vars;
}

const env = loadEnv();
const secret = env.STRIPE_WEBHOOK_SECRET;
if (!secret) {
  console.error(
    "[simulator] FATAL: STRIPE_WEBHOOK_SECRET is not set (env or .env.local). " +
      "It must be the same TEST secret the hub uses to verify webhooks.",
  );
  process.exit(1);
}
const redacted = secret.slice(0, SECRET_REDACT_KEEP) + "...";
console.log(`[simulator] using webhook secret ${redacted} (redacted)`);

const target = env.WEBHOOK_TARGET_URL || DEFAULT_TARGET;
console.log(`[simulator] target: ${target}`);

// ---------------------------------------------------------------------------
// event catalog: JSON fixtures, one file per event type (+ edge variants)
// ---------------------------------------------------------------------------
function listCatalog() {
  return fs
    .readdirSync(EVENTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

// ---------------------------------------------------------------------------
// signing: byte-identical to Stripe's format
// ---------------------------------------------------------------------------
function signEvent(rawBody, webhookSecret) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto
    .createHmac("sha256", webhookSecret)
    .update(`${t}.${rawBody}`)
    .digest("hex");
  return { t, v1, header: `t=${t},v1=${v1}` };
}

// ---------------------------------------------------------------------------
// local verification with the real Stripe SDK (proves byte-identical signing)
// ---------------------------------------------------------------------------
function verifySignatureLocally(rawBody, header, webhookSecret) {
  let Stripe;
  try {
    Stripe = require("stripe");
  } catch (err) {
    console.warn(
      `[simulator] WARN: stripe package not resolvable, skipping local constructEvent check (${err.message})`,
    );
    return;
  }
  let stripe;
  try {
    stripe = new Stripe(env.STRIPE_SECRET_KEY || "sk_test_dummy_for_verify");
  } catch (err) {
    console.warn(`[simulator] WARN: could not init stripe client for verify (${err.message})`);
    return;
  }
  try {
    const evt = stripe.webhooks.constructEvent(rawBody, header, webhookSecret);
    console.log(
      `[simulator] OK: stripe.webhooks.constructEvent verified signature ` +
        `(id=${evt.id}, type=${evt.type}) - bytes match Stripe's format exactly`,
    );
  } catch (err) {
    console.error(`[simulator] FATAL: constructEvent REJECTED the signature: ${err.message}`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// delivery
// ---------------------------------------------------------------------------
function postRaw(rawBody, header) {
  const url = new URL(target);
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(rawBody),
          "stripe-signature": header,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", (err) => reject(err));
    req.write(rawBody);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// payload builders
// ---------------------------------------------------------------------------
function freshId(prefix) {
  return `${prefix}_sim_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function loadFixture(fileName, overrides) {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(EVENTS_DIR, fileName), "utf8"),
  );
  const evt = JSON.parse(JSON.stringify(fixture)); // deep copy
  // fresh, unique event identity per delivery
  evt.id = freshId("evt");
  evt.created = Math.floor(Date.now() / 1000);
  const obj = evt.data.object;
  if (overrides.email) {
    if (obj.customer_details) obj.customer_details.email = overrides.email;
    if (obj.metadata) obj.metadata.email = overrides.email;
  }
  if (overrides.price && obj.items && obj.items.data && obj.items.data[0] && obj.items.data[0].price) {
    obj.items.data[0].price.id = overrides.price;
  }
  if (overrides.status && obj.status !== undefined) {
    obj.status = overrides.status;
  }
  return evt;
}

function applyBadSignature(header) {
  // flip one hex char of v1 so verification must fail
  const parts = header.split(",");
  const v1 = parts[1].replace(/^v1=/, "");
  const mangled = (v1[0] === "0" ? "1" : "0") + v1.slice(1);
  return `${parts[0]},v1=${mangled}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      args.flags[key] = val;
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

const CORE_TYPES = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
];

function fireEventType(eventType, overrides, options = {}) {
  const fixtureName = `${eventType}.json`;
  if (!fs.existsSync(path.join(EVENTS_DIR, fixtureName))) {
    console.error(
      `[simulator] FATAL: unknown event type "${eventType}". ` +
        `Available: ${listCatalog().map((f) => f.replace(".json", "")).join(", ")}`,
    );
    process.exit(1);
  }
  const evt = loadFixture(fixtureName, overrides);
  const rawBody = JSON.stringify(evt);
  let sig = signEvent(rawBody, secret);
  if (options.badSignature) {
    sig.header = applyBadSignature(sig.header);
    console.log("[simulator] delivering with TAMPERED signature (expect hub 400)");
  } else {
    verifySignatureLocally(rawBody, sig.header, secret);
  }
  const v1short = sig.v1.slice(0, 16) + "...";
  console.log(
    `[simulator] firing ${evt.type} -> ${target}\n` +
      `  id=${evt.id} sig=${sig.header.replace(/v1=.+/, `v1=${v1short}`)} body=${rawBody.length} bytes`,
  );
  const deliveries = options.duplicate ? 2 : 1;
  return (async () => {
    if (options.delay) await new Promise((r) => setTimeout(r, options.delay));
    for (let i = 1; i <= deliveries; i++) {
      if (deliveries > 1) console.log(`[simulator] delivery ${i}/${deliveries} (byte-identical replay)`);
      try {
        const res = await postRaw(rawBody, sig.header);
        console.log(`[simulator] <- HTTP ${res.status} ${res.body.slice(0, 200)}`);
      } catch (err) {
        console.error(`[simulator] <- transport error: ${err.message}`);
      }
    }
  })();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.list) {
    console.log("[simulator] event catalog:");
    for (const f of listCatalog()) {
      console.log(`  - ${f.replace(".json", "")}`);
    }
    return;
  }

  if (args.flags["self-test"]) {
    const eventType = args.positional[0];
    if (!eventType) {
      console.error("[simulator] --self-test requires an event type: node test/simulator/index.js <type> --self-test");
      process.exit(1);
    }
    const fixtureName = `${eventType}.json`;
    if (!fs.existsSync(path.join(EVENTS_DIR, fixtureName))) {
      console.error(`[simulator] unknown event type "${eventType}"`);
      process.exit(1);
    }
    const evt = loadFixture(fixtureName, {});
    const rawBody = JSON.stringify(evt);
    const sig = signEvent(rawBody, secret);
    verifySignatureLocally(rawBody, sig.header, secret);
    console.log("[simulator] self-test passed (no POST made)");
    return;
  }

  if (args.flags.matrix) {
    console.log(`[simulator] matrix: firing ${CORE_TYPES.length} event types in sequence`);
    for (const type of CORE_TYPES) {
      await fireEventType(type, {});
    }
    return;
  }

  const eventType = args.positional[0];
  if (!eventType) {
    console.log(
      "usage: node test/simulator/index.js <event-type> [--email <email>] [--price <price_id>] " +
        "[--status <status>] [--duplicate] [--bad-signature] [--delay <ms>] [--self-test] [--list] | --matrix\n" +
        `event types: ${CORE_TYPES.join(" | ")}`,
    );
    return;
  }

  const overrides = {};
  if (args.flags.email) overrides.email = String(args.flags.email);
  if (args.flags.price) overrides.price = String(args.flags.price);
  if (args.flags.status) overrides.status = String(args.flags.status);

  await fireEventType(eventType, overrides, {
    badSignature: Boolean(args.flags["bad-signature"]),
    duplicate: Boolean(args.flags.duplicate),
    delay: Number(args.flags.delay) || 0,
  });
}

main().catch((err) => {
  console.error("[simulator] unhandled error:", err);
  process.exit(1);
});
