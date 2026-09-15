#!/usr/bin/env node
/**
 * Group A (money safety) harness — WWV hub billing webhook.
 *
 * Drives the REAL hub HTTP endpoint (a live `next dev` server on a spare port)
 * with REAL Stripe-signed raw bodies, against the REAL `webhook_events` ledger
 * in the local Supabase Postgres/PostgREST stack.
 *
 * WHAT IS REAL
 *   - Transport: TCP socket + the full Next.js route pipeline (proxy.ts
 *     middleware included). Not an in-process import of POST().
 *   - Signature verification: the hub runs its own
 *     `stripe.webhooks.constructEvent`; this driver signs the raw bytes with
 *     HMAC-SHA256 in Stripe's exact `t=<ts>,v1=<sig>` format and re-verifies
 *     every body locally with the real Stripe SDK before sending it, so the
 *     bytes are provably byte-identical to a Stripe delivery.
 *   - Ledger: `@supabase/supabase-js` -> PostgREST -> Postgres, the same
 *     connection `claimWebhookEvent` / `completeWebhookEvent` /
 *     `failWebhookEvent` use, and the real
 *     supabase/migrations/20260915000001_webhook_events_completion_state.sql DDL.
 *   - Cross-service signing: the hub signs with the real
 *     `src/lib/cross-service/sign.ts` HMAC and both stand-in servers record the
 *     headers they actually received.
 *   - Stripe outbound HTTP: the real stripe-node SDK (real retry policy, real
 *     error mapping) issuing real requests to a stand-in Stripe HTTP server.
 *     Only Stripe's *server* is a stand-in; the SDK is not mocked or stubbed.
 *
 * WHAT IS STOOD IN FOR (and why it has to be)
 *   - api.stripe.com -> a local HTTP server speaking Stripe's wire format, so a
 *     mid-handler outage can be injected deterministically and offline.
 *   - the globe's /api/provision and /api/service/tier-sync -> a local HTTP
 *     counter, so "did the handler do downstream work" is answered by observed
 *     network traffic rather than by a spy.
 *
 * Usage:
 *   node groupa-harness.mjs --hub-cwd <worktree> [--hub-port 3011]
 *                           [--globe-port 30191] [--stripe-port 30192]
 *                           [--out <dir>] [--only A1,A2]
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

// ── args ────────────────────────────────────────────────────────────────────
function argVal(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : dflt;
}
const HUB_CWD = path.resolve(argVal("hub-cwd", process.cwd()));
const HUB_PORT = Number(argVal("hub-port", "3011"));
const GLOBE_PORT = Number(argVal("globe-port", "30191"));
const STRIPE_PORT = Number(argVal("stripe-port", "30192"));
const OUT_DIR = path.resolve(argVal("out", path.join(HUB_CWD, "temp", "billing-group-a-evidence")));
const ONLY = String(argVal("only", "")).split(",").map((s) => s.trim()).filter(Boolean);

const HUB_URL = `http://127.0.0.1:${HUB_PORT}`;
const WEBHOOK_URL = `${HUB_URL}/api/billing/webhook`;
const GLOBE_URL = `http://127.0.0.1:${GLOBE_PORT}`;

// TEST-ONLY values. The Supabase keys are the well-known `supabase start`
// local defaults (see docker-compose.test.yml); nothing here is a live secret.
const WEBHOOK_SECRET = "whsec_group_a_harness_secret";
const CROSS_SERVICE_SECRET = "group-a-cross-service-secret";
const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTk5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

// ── transcript ──────────────────────────────────────────────────────────────
const lines = [];
const failures = [];
const checks = [];
function say(line = "") {
  lines.push(line);
  process.stdout.write(line + "\n");
}
function block(header, bodyLines) {
  say(`---- ${header} ----`);
  for (const l of bodyLines) say(l);
  say(`---- end ${header} ----`);
}
function check(name, condition, detail) {
  const ok = Boolean(condition);
  checks.push({ name, ok, detail: detail ?? null });
  if (!ok) failures.push(`${name}${detail ? ` :: ${detail}` : ""}`);
  say(`[CHECK] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
  return ok;
}

// ── Stripe-format signing (byte-identical to a real delivery) ───────────────
function signRaw(rawBody, secret) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v1=${v1}`;
}
function tamper(header) {
  const parts = header.split(",");
  const v1 = parts[1].replace(/^v1=/, "");
  const flipped = (v1[0] === "0" ? "1" : "0") + v1.slice(1);
  return `${parts[0]},v1=${flipped}`;
}
const verifyStripe = new Stripe("sk_test_group_a_local_verify_only");
function verifyLocally(rawBody, header) {
  // Proves the bytes this driver sends are exactly what Stripe would send.
  const evt = verifyStripe.webhooks.constructEvent(rawBody, header, WEBHOOK_SECRET);
  return evt;
}

// ── raw HTTP POST ───────────────────────────────────────────────────────────
function rawPost(url, body, headers) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let b = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (b += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: b, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── stand-in globe (real HTTP, real HMAC headers observed) ──────────────────
const globe = {
  hits: [],
  provision: { status: 200, body: '{"ok":true}', delayMs: 0 },
  tierSync: { status: 200, body: '{"ok":true}', delayMs: 0 },
  reset() {
    this.hits.length = 0;
    this.provision = { status: 200, body: '{"ok":true}', delayMs: 0 };
    this.tierSync = { status: 200, body: '{"ok":true}', delayMs: 0 };
  },
  count(p) {
    return this.hits.filter((h) => h.path.includes(p)).length;
  },
};
function startGlobe() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const cfg = req.url?.includes("/api/provision") ? globe.provision : globe.tierSync;
      globe.hits.push({
        method: req.method ?? "",
        path: req.url ?? "",
        body,
        at: Date.now(),
        signature: req.headers["x-service-signature"] ?? null,
        timestamp: req.headers["x-service-timestamp"] ?? null,
        nonce: req.headers["x-service-nonce"] ?? null,
      });
      setTimeout(() => {
        res.writeHead(cfg.status, { "content-type": "application/json" });
        res.end(cfg.body);
      }, cfg.delayMs);
    });
  });
  return new Promise((r) => server.listen(GLOBE_PORT, "127.0.0.1", () => r(server)));
}

// ── stand-in Stripe (real stripe-node SDK -> real HTTP) ─────────────────────
const stripeApi = {
  mode: "ok", // "ok" | "outage" | "slowfail-once"
  slowFailMs: 2500,
  checkoutSession: null,
  customer: { id: "cus_group_a", object: "customer", deleted: false, email: null },
  subscription: { id: "sub_group_a", object: "subscription", items: { object: "list", data: [] } },
  hits: [],
  reset() {
    this.mode = "ok";
    this.slowFailMs = 2500;
    this.checkoutSession = null;
    this.hits.length = 0;
  },
  count(p) {
    return this.hits.filter((h) => h.path.includes(p)).length;
  },
};
function startStripe() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${STRIPE_PORT}`);
      stripeApi.hits.push({ method: req.method ?? "", path: url.pathname, at: Date.now() });
      const send = (status, obj) => {
        const payload = JSON.stringify(obj);
        res.writeHead(status, { "content-type": "application/json", "request-id": "req_group_a" });
        res.end(payload);
      };
      if (stripeApi.mode === "outage") {
        // A 400-level Stripe API error: stripe-node never retries a 4xx, so the
        // injected failure is deterministic and fast. This is the "mid-handler
        // error" the group A scenarios require.
        return send(400, {
          error: {
            type: "invalid_request_error",
            message: "GROUP A INJECTED STRIPE OUTAGE",
          },
        });
      }
      if (stripeApi.mode === "slowfail-once") {
        // The FIRST request (in-flight delivery X) is held open and then fails;
        // every later request (delivery Y) succeeds immediately. This makes X's
        // failure arrive AFTER Y has already completed the same event, which is
        // the interleaving that proves failWebhookEvent cannot un-complete a
        // completion written by a concurrent sibling.
        stripeApi.mode = "ok";
        return setTimeout(
          () =>
            send(400, {
              error: { type: "invalid_request_error", message: "GROUP A SLOW INJECTED OUTAGE" },
            }),
          stripeApi.slowFailMs,
        );
      }
      if (url.pathname.startsWith("/v1/checkout/sessions/")) {
        return send(200, stripeApi.checkoutSession);
      }
      if (url.pathname.startsWith("/v1/customers/")) {
        return send(200, stripeApi.customer);
      }
      if (url.pathname.startsWith("/v1/subscriptions/")) {
        return send(200, stripeApi.subscription);
      }
      return send(404, { error: { type: "invalid_request_error", message: "not found" } });
    });
  });
  return new Promise((r) => server.listen(STRIPE_PORT, "127.0.0.1", () => r(server)));
}

// ── the hub under test ──────────────────────────────────────────────────────
let hubProc = null;
function hubEnv() {
  return {
    ...process.env,
    PATH: process.env.PATH,
    CI: "true",
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    // --- hub config under test ---
    STRIPE_SECRET_KEY: "sk_test_group_a_local",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_HOST: "127.0.0.1",
    STRIPE_PORT: String(STRIPE_PORT),
    STRIPE_PROTOCOL: "http",
    STRIPE_PRO_PRICE_ID: "price_pro_monthly",
    STRIPE_PRO_ANNUAL_PRICE_ID: "price_pro_yearly",
    STRIPE_TEAM_MONTHLY_PRICE_ID: "price_team_monthly",
    STRIPE_TEAM_ANNUAL_PRICE_ID: "price_team_yearly",
    CROSS_SERVICE_SECRET,
    PROVISIONING_API_URL: GLOBE_URL,
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    SUPABASE_INTERNAL_URL: SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    NEXT_PUBLIC_BILLING_ENABLED: "true",
  };
}
async function startHub(logPath) {
  const fd = fs.openSync(logPath, "w");
  hubProc = spawn(
    process.execPath,
    [path.join(HUB_CWD, "node_modules", "next", "dist", "bin", "next"), "dev", "--webpack", "--port", String(HUB_PORT), "--hostname", "127.0.0.1"],
    { cwd: HUB_CWD, env: hubEnv(), stdio: ["ignore", fd, fd] },
  );
  say(`[SETUP] hub dev server pid=${hubProc.pid} on ${HUB_URL} (log: ${logPath})`);
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try {
      const probe = await rawPost(WEBHOOK_URL, '{"probe":true}', { "stripe-signature": "t=1,v1=deadbeef" });
      if (probe.status === 400) {
        say(`[SETUP] hub route is serving (readiness probe -> HTTP ${probe.status} on the signature check)`);
        return;
      }
    } catch {
      /* not listening yet */
    }
    await sleep(2000);
  }
  throw new Error(`hub did not become ready within 240s; see ${logPath}`);
}
function stopHub() {
  if (!hubProc) return;
  try {
    spawnSync("taskkill", ["/pid", String(hubProc.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* best effort */
  }
  hubProc = null;
}
function hubLog(logPath, pattern, max = 8) {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes(pattern))
    .slice(0, max);
}

// ── ledger helpers (real PostgREST) ─────────────────────────────────────────
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
async function ledger(eventId) {
  const { data, error } = await admin.from("webhook_events").select("*").eq("event_id", eventId);
  if (error) throw new Error(`ledger read failed: ${error.message}`);
  return data ?? [];
}
async function ledgerCount(eventId) {
  const { count, error } = await admin
    .from("webhook_events")
    .select("event_id", { count: "exact", head: true })
    .eq("event_id", eventId);
  if (error) throw new Error(`ledger count failed: ${error.message}`);
  return count ?? 0;
}
async function ledgerCleanup() {
  await admin.from("webhook_events").delete().like("event_id", "evt_groupa_%");
}

// ── payloads ────────────────────────────────────────────────────────────────
function checkoutEvent(eventId, sessionId, email) {
  return {
    id: eventId,
    object: "event",
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        client_reference_id: null,
        customer: "cus_group_a",
        customer_email: email,
        customer_details: { name: "Group A", email },
        metadata: {},
        subscription: "sub_group_a",
      },
    },
  };
}
function subscriptionEvent(eventId, email) {
  return {
    id: eventId,
    object: "event",
    type: "customer.subscription.deleted",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: "sub_group_a",
        object: "subscription",
        customer: "cus_group_a",
        customer_email: email,
        status: "canceled",
      },
    },
  };
}
/** The object the hub's outbound `checkout.sessions.retrieve` will receive. */
function retrievedSession(sessionId, email, hubUserId) {
  return {
    id: sessionId,
    object: "checkout.session",
    client_reference_id: hubUserId ?? null,
    customer: "cus_group_a",
    customer_email: email,
    customer_details: { name: "Group A", email },
    metadata: hubUserId ? { userId: hubUserId } : {},
    subscription: {
      id: "sub_group_a",
      object: "subscription",
      status: "trialing",
      trial_end: 1893456000,
      items: {
        object: "list",
        data: [
          {
            id: "si_group_a",
            object: "subscription_item",
            price: { id: "price_pro_monthly", object: "price" },
          },
        ],
      },
    },
  };
}

// ── leak scan ───────────────────────────────────────────────────────────────
const LEAK_PATTERNS = [
  ["webhook secret", /whsec_/i],
  ["stripe secret key", /sk_test|sk_live/i],
  ["service-role key", /service_role/i],
  ["raw jwt", /eyJhbGciOiJIUzI1NiIsInR5cCI6/],
  ["node stack frame", /\n\s+at [\w$.]+ \(/],
  ["source path", /[A-Za-z]:\\|\/src\/|\.ts:\d+/],
  ["db internals", /postgres|postgrest|pg_|relation "/i],
  ["cross-service secret", /group-a-cross-service-secret/],
];
function leakScan(label, body) {
  const found = LEAK_PATTERNS.filter(([, re]) => re.test(body)).map(([n]) => n);
  say(`[LEAKSCAN] ${label}: ${found.length === 0 ? "clean (no secret, no stack frame, no internal path)" : `HIT -> ${found.join(", ")}`}`);
  return found;
}

// ── misc ────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (b) => {
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
};
async function deliver(eventObj, opts = {}) {
  const raw = JSON.stringify(eventObj);
  let sig = signRaw(raw, WEBHOOK_SECRET);
  if (opts.tamperSignature) sig = tamper(sig);
  if (opts.noSignature) sig = null;
  if (!opts.tamperSignature && !opts.noSignature) {
    const verified = verifyLocally(raw, sig);
    if (verified.id !== eventObj.id) throw new Error("local signature verification mismatch");
  }
  const headers = sig ? { "stripe-signature": sig } : {};
  const t0 = Date.now();
  const res = await rawPost(WEBHOOK_URL, raw, headers);
  return { ...res, ms: Date.now() - t0, raw, sig };
}
function want(name) {
  return ONLY.length === 0 || ONLY.includes(name);
}

// ── scenarios ───────────────────────────────────────────────────────────────
async function scenarioA1(hubLogPath) {
  if (!want("A1")) return;
  say("");
  say("=====================================================================");
  say("A1  payment confirmed, never delivered  (force a mid-handler error)");
  say("    expected after the D1 fix: the failure is RETURNED to Stripe so it");
  say("    retries, AND a durable unfinished record exists, AND the retry");
  say("    actually reprocesses instead of being absorbed as a duplicate.");
  say("=====================================================================");
  const EVENT_ID = "evt_groupa_a1_0001";
  const SESSION_ID = "cs_groupa_a1_0001";
  await admin.from("webhook_events").delete().eq("event_id", EVENT_ID);

  stripeApi.reset();
  stripeApi.mode = "outage";
  stripeApi.checkoutSession = retrievedSession(SESSION_ID, "a1@group-a.test", "user_groupa_a1");
  globe.reset();

  const evt = checkoutEvent(EVENT_ID, SESSION_ID, "a1@group-a.test");

  // ── delivery 1: mid-handler failure ──────────────────────────────────────
  const r1 = await deliver(evt);
  const b1 = json(r1.body);
  const rows1 = await ledger(EVENT_ID);
  say("");
  say(`[EVIDENCE A1.a] delivery 1 HTTP status = ${r1.status}`);
  say(`[EVIDENCE A1.a] delivery 1 response body = ${r1.body.slice(0, 200)}`);
  say(`[EVIDENCE A1.a] injected failure = the hub's outbound Stripe call (real stripe-node -> ${STRIPE_PORT})`);
  say(`[EVIDENCE A1.a] stripe-node requests observed during delivery 1 = ${stripeApi.count("/v1/checkout/sessions/")}`);
  say(`[EVIDENCE A1.b] durable ledger rows for the event AFTER the failed delivery = ${rows1.length}`);
  say(`[EVIDENCE A1.b] row = ${JSON.stringify(rows1[0] ?? null)}`);
  say(`[EVIDENCE A1.b] downstream globe calls during the failed delivery = ${globe.hits.length}`);
  block("hub log: the failure", hubLog(hubLogPath, "Handling FAILED"));

  check("A1: a mid-handler failure answers 500, not 200", r1.status === 500, `status=${r1.status}`);
  check(
    "A1: the 500 body states the failure without leaking internals",
    b1 && b1.received === false && b1.error === "Webhook handling failed",
    JSON.stringify(b1),
  );
  check("A1: exactly one durable ledger row exists after the failed delivery", rows1.length === 1, `rows=${rows1.length}`);
  check(
    "A1: the row is UNFINISHED (processed_at IS NULL) so a retry may reprocess",
    rows1[0]?.processed_at === null,
    `processed_at=${JSON.stringify(rows1[0]?.processed_at)}`,
  );
  check(
    "A1: the row records the failure reason durably",
    typeof rows1[0]?.last_error === "string" && rows1[0].last_error.length > 0,
    `last_error=${JSON.stringify(rows1[0]?.last_error)}`,
  );
  check("A1: the row records when the attempt failed", Boolean(rows1[0]?.last_attempt_at), `last_attempt_at=${rows1[0]?.last_attempt_at}`);
  check("A1: no downstream work happened during the failed delivery", globe.hits.length === 0, `hits=${globe.hits.length}`);

  // ── delivery 2: Stripe retries, service recovered ────────────────────────
  stripeApi.mode = "ok";
  stripeApi.hits.length = 0;
  const r2 = await deliver(evt);
  const b2 = json(r2.body);
  const rows2 = await ledger(EVENT_ID);
  say("");
  say(`[EVIDENCE A1.c] RETRY (byte-identical body) HTTP status = ${r2.status}`);
  say(`[EVIDENCE A1.c] retry response body = ${r2.body.slice(0, 200)}`);
  say(`[EVIDENCE A1.c] downstream globe calls during the retry = ${globe.hits.length} ${JSON.stringify(globe.hits.map((h) => `${h.method} ${h.path}`))}`);
  say(`[EVIDENCE A1.c] row after the retry = ${JSON.stringify(rows2[0] ?? null)}`);

  check("A1: the Stripe retry is ACCEPTED and completes (200)", r2.status === 200, `status=${r2.status}`);
  check("A1: the retry response is the plain success shape", b2 && b2.received === true && !b2.duplicate, JSON.stringify(b2));
  check(
    "A1: the retry actually REPROCESSED - provisioning was attempted",
    globe.count("/api/provision") === 1,
    `provision hits=${globe.count("/api/provision")}`,
  );
  check(
    "A1: the retry actually REPROCESSED - the tier was synced",
    globe.count("/api/service/tier-sync") === 1,
    `tier-sync hits=${globe.count("/api/service/tier-sync")}`,
  );
  check("A1: the retry left exactly one ledger row (no duplicate row)", rows2.length === 1, `rows=${rows2.length}`);
  check(
    "A1: the row is now COMPLETED (processed_at set) and the error cleared",
    Boolean(rows2[0]?.processed_at) && rows2[0]?.last_error === null,
    JSON.stringify(rows2[0] ?? null),
  );

  // ── delivery 3: a genuine replay must now be absorbed ────────────────────
  const before3 = globe.hits.length;
  const r3 = await deliver(evt);
  const b3 = json(r3.body);
  say("");
  say(`[EVIDENCE A1.d] replay AFTER a completed handling: HTTP ${r3.status} ${r3.body.slice(0, 120)}`);
  say(`[EVIDENCE A1.d] downstream globe calls added by the replay = ${globe.hits.length - before3}`);
  check("A1: a replay of a COMPLETED event still answers 200", r3.status === 200, `status=${r3.status}`);
  check("A1: a replay of a COMPLETED event is marked duplicate", b3 && b3.duplicate === true, JSON.stringify(b3));
  check("A1: a replay of a COMPLETED event does no downstream work", globe.hits.length === before3, `added=${globe.hits.length - before3}`);
  leakScan("A1 delivery 1 (500)", r1.body);
  leakScan("A1 delivery 2 (200)", r2.body);
}

async function scenarioA2(hubLogPath) {
  if (!want("A2")) return;
  say("");
  say("=====================================================================");
  say("A2  the same payment twice  (atomic claim; the second delivery is");
  say("    absorbed; the claim is written BEFORE the work)");
  say("=====================================================================");
  stripeApi.reset();
  globe.reset();

  // ── (a) first delivery completes ─────────────────────────────────────────
  const E = "evt_groupa_a2_0001";
  await admin.from("webhook_events").delete().like("event_id", "evt_groupa_a2%");
  stripeApi.checkoutSession = retrievedSession("cs_groupa_a2_0001", "a2@group-a.test", "user_groupa_a2");
  const evt = checkoutEvent(E, "cs_groupa_a2_0001", "a2@group-a.test");
  const ra = await deliver(evt);
  const raBody = json(ra.body);
  say("");
  say(`[EVIDENCE A2.a] delivery 1 HTTP ${ra.status} ${ra.body.slice(0, 120)}`);
  say(`[EVIDENCE A2.a] downstream globe calls = ${globe.hits.length} ${JSON.stringify(globe.hits.map((h) => h.path))}`);
  const rowsA = await ledger(E);
  say(`[EVIDENCE A2.a] ledger = ${JSON.stringify(rowsA[0] ?? null)}`);
  check("A2: the first delivery succeeds (200, not duplicate)", ra.status === 200 && raBody?.duplicate !== true, `${ra.status} ${ra.body.slice(0, 80)}`);
  check("A2: the first delivery did the downstream work", globe.count("/api/provision") === 1 && globe.count("/api/service/tier-sync") === 1, `provision=${globe.count("/api/provision")} tier=${globe.count("/api/service/tier-sync")}`);

  // ── (b) byte-identical second delivery ───────────────────────────────────
  const beforeB = globe.hits.length;
  stripeApi.hits.length = 0;
  const rb = await deliver(evt);
  const rbBody = json(rb.body);
  const rowsB = await ledger(E);
  say("");
  say(`[EVIDENCE A2.b] byte-identical second delivery HTTP ${rb.status} ${rb.body.slice(0, 120)}`);
  say(`[EVIDENCE A2.b] stripe-node requests during it = ${stripeApi.hits.length}`);
  say(`[EVIDENCE A2.b] downstream globe calls added = ${globe.hits.length - beforeB}`);
  say(`[EVIDENCE A2.b] ledger rows = ${rowsB.length}`);
  check("A2: the second delivery is ignored with 200", rb.status === 200, `status=${rb.status}`);
  check("A2: the second delivery is reported as a duplicate", rbBody?.duplicate === true, JSON.stringify(rbBody));
  check("A2: the second delivery did NO downstream work", globe.hits.length === beforeB, `added=${globe.hits.length - beforeB}`);
  check("A2: the second delivery did not even call Stripe", stripeApi.hits.length === 0, `stripe hits=${stripeApi.hits.length}`);
  check("A2: still exactly one ledger row for the payment", rowsB.length === 1, `rows=${rowsB.length}`);

  // ── (c) the claim is atomic: N concurrent deliveries, one row ────────────
  const C = "evt_groupa_a2c_0001";
  await admin.from("webhook_events").delete().eq("event_id", C);
  globe.reset();
  globe.provision.delayMs = 1200; // hold the handler open so the claims overlap
  const evtC = checkoutEvent(C, "cs_groupa_a2c_0001", "a2c@group-a.test");
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => deliver(evtC)));
  const rowsC = await ledger(C);
  say("");
  say(`[EVIDENCE A2.c] 5 concurrent deliveries of ONE event: HTTP ${JSON.stringify(results.map((r) => r.status))}`);
  say(`[EVIDENCE A2.c] ledger rows for that event = ${rowsC.length} (the atomic INSERT ... ON CONFLICT DO NOTHING claim)`);
  say(`[EVIDENCE A2.c] downstream /api/provision hits = ${globe.count("/api/provision")} (how many deliveries were allowed to process)`);
  say(`[EVIDENCE A2.c] observed contract = at-least-once; the ledger never gains a second row for the same event`);
  check("A2: concurrent deliveries of one event create exactly ONE ledger row", rowsC.length === 1, `rows=${rowsC.length}`);
  check("A2: no concurrent delivery is answered with a 5xx", results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
  globe.provision.delayMs = 0;

  // ── (d) the claim is written BEFORE the work begins ──────────────────────
  // The handler is held open for 2.5s by the stand-in globe, and the ledger is
  // polled until the claim row first becomes visible. Seeing the row with
  // processed_at still NULL, well before the delivery returns, is the ordering
  // proof: the durable record exists before the work it protects.
  const D = "evt_groupa_a2d_0001";
  await admin.from("webhook_events").delete().eq("event_id", D);
  globe.reset();
  globe.provision.delayMs = 2500;
  const evtD = checkoutEvent(D, "cs_groupa_a2d_0001", "a2d@group-a.test");
  const t0 = Date.now();
  const inflight = deliver(evtD);
  let firstSeenMs = null;
  let midRows = [];
  let midGlobe = 0;
  while (Date.now() - t0 < 2200) {
    await sleep(120);
    const r = await ledger(D);
    if (r.length > 0) {
      firstSeenMs = Date.now() - t0;
      midRows = r;
      midGlobe = globe.hits.length;
      break;
    }
  }
  const rd = await inflight;
  const totalMs = Date.now() - t0;
  const afterRows = await ledger(D);
  globe.provision.delayMs = 0;
  say("");
  say(`[EVIDENCE A2.d] the claim row first became visible ${firstSeenMs ?? "never"}ms into a delivery that took ${totalMs}ms`);
  say(`[EVIDENCE A2.d] the row at that moment = ${JSON.stringify(midRows[0] ?? null)}`);
  say(`[EVIDENCE A2.d] downstream hits at that moment = ${midGlobe} (the handler was still working)`);
  say(`[EVIDENCE A2.d] after completion: HTTP ${rd.status}, row = ${JSON.stringify(afterRows[0] ?? null)}`);
  check("A2: the claim row is durable BEFORE the handler finishes its work", firstSeenMs !== null, `first seen at ${firstSeenMs}ms of ${totalMs}ms`);
  check("A2: the claim row appears well before completion (not at the end)", firstSeenMs !== null && firstSeenMs < totalMs - 500, `first seen ${firstSeenMs}ms, completed ${totalMs}ms`);
  check("A2: the mid-flight row is still unfinished (processed_at IS NULL)", midRows[0]?.processed_at === null, `processed_at=${JSON.stringify(midRows[0]?.processed_at)}`);
  check("A2: the handler really was still in flight (downstream call already observed)", midGlobe >= 1, `hits=${midGlobe}`);
  check("A2: completion flips the row to processed", Boolean(afterRows[0]?.processed_at), JSON.stringify(afterRows[0] ?? null));

  // ── (e) a FAILING sibling cannot un-complete a completed row ─────────────
  // Delivery X strands inside the Stripe call and fails 2.5s later; delivery Y
  // starts 500ms in, is accepted, and completes the same event. X's failure
  // write is guarded by `processed_at IS NULL` and must therefore be a no-op.
  const F = "evt_groupa_a2e_0001";
  await admin.from("webhook_events").delete().eq("event_id", F);
  globe.reset();
  stripeApi.reset();
  stripeApi.mode = "slowfail-once";
  stripeApi.slowFailMs = 2500;
  stripeApi.checkoutSession = retrievedSession("cs_groupa_a2e_0001", "a2e@group-a.test", "user_groupa_a2e");
  const evtF = checkoutEvent(F, "cs_groupa_a2e_0001", "a2e@group-a.test");
  const xPromise = deliver(evtF);
  await sleep(500);
  const ry = await deliver(evtF); // sibling Y: same event, Stripe now healthy
  const completedRow = (await ledger(F))[0] ?? null;
  const rx = await xPromise; // sibling X: still stranded, fails last
  const finalRow = (await ledger(F))[0] ?? null;
  say("");
  say(`[EVIDENCE A2.e] sibling X (stalled, fails last) HTTP ${rx.status} ${rx.body.slice(0, 120)}`);
  say(`[EVIDENCE A2.e] sibling Y (accepted mid-flight) HTTP ${ry.status} ${ry.body.slice(0, 120)}`);
  say(`[EVIDENCE A2.e] row after Y completed  = ${JSON.stringify(completedRow)}`);
  say(`[EVIDENCE A2.e] row after X failed     = ${JSON.stringify(finalRow)}`);
  check("A2: the mid-flight sibling Y was accepted and completed the event", ry.status === 200, `status=${ry.status}`);
  check("A2: the late-failing sibling X returns 500 as designed", rx.status === 500, `status=${rx.status}`);
  check(
    "A2: the failing sibling did NOT un-complete the completed row",
    Boolean(finalRow?.processed_at) && finalRow.processed_at === completedRow?.processed_at,
    `before=${completedRow?.processed_at} after=${finalRow?.processed_at}`,
  );
  check(
    "A2: the failing sibling did NOT stamp a spurious error on the completed row",
    finalRow?.last_error === null,
    `last_error=${JSON.stringify(finalRow?.last_error)}`,
  );
  check("A2: still exactly one ledger row after both siblings", (await ledger(F)).length === 1, "expected 1");
  block("hub log (A2 window)", hubLog(hubLogPath, "[webhook]", 6));
}

async function scenarioA3() {
  if (!want("A3")) return;
  say("");
  say("=====================================================================");
  say("A3  forged signature  (hard 400 reject, distinguishable, ledger");
  say("    untouched, zero downstream work)");
  say("=====================================================================");
  const E = "evt_groupa_a3_forged_0001";
  await admin.from("webhook_events").delete().like("event_id", "evt_groupa_a3%");
  stripeApi.reset();
  globe.reset();
  stripeApi.checkoutSession = retrievedSession("cs_groupa_a3_0001", "a3@group-a.test", "user_groupa_a3");

  const evt = checkoutEvent(E, "cs_groupa_a3_0001", "a3@group-a.test");
  // A tampered signature over an otherwise valid, correctly-shaped body.
  const forged = await deliver(evt, { tamperSignature: true });
  const forgedBody = forged.body;
  const rowsForged = await ledgerCount(E);
  say("");
  say(`[EVIDENCE A3.a] tampered signature -> HTTP ${forged.status}`);
  say(`[EVIDENCE A3.a] response body = ${JSON.stringify(forgedBody.slice(0, 300))}`);
  say(`[EVIDENCE A3.a] response content-type = ${forged.headers?.["content-type"]}`);
  say(`[EVIDENCE A3.a] webhook_events rows created for the forged event = ${rowsForged}`);
  say(`[EVIDENCE A3.a] downstream globe calls during the forgery = ${globe.hits.length}`);
  say(`[EVIDENCE A3.a] stripe-node requests during the forgery = ${stripeApi.hits.length}`);
  check("A3: a forged signature is rejected with a hard 400", forged.status === 400, `status=${forged.status}`);
  check("A3: the 400 is distinguishable from a transport/other failure", /Webhook Error/i.test(forgedBody), forgedBody.slice(0, 120));
  check("A3: the forged delivery claimed NOTHING in the ledger", rowsForged === 0, `rows=${rowsForged}`);
  check("A3: the forged delivery did NO downstream work", globe.hits.length === 0, `hits=${globe.hits.length}`);
  check("A3: the forged delivery reached no Stripe call", stripeApi.hits.length === 0, `stripe hits=${stripeApi.hits.length}`);

  // A missing signature header is the other half of "hard reject".
  const unsigned = await deliver(evt, { noSignature: true });
  const rowsUnsigned = await ledgerCount(E);
  say("");
  say(`[EVIDENCE A3.b] missing stripe-signature header -> HTTP ${unsigned.status}; body = ${JSON.stringify(unsigned.body.slice(0, 200))}`);
  say(`[EVIDENCE A3.b] ledger rows after the unsigned delivery = ${rowsUnsigned}`);
  check("A3: a missing signature header is also rejected 400", unsigned.status === 400, `status=${unsigned.status}`);
  check("A3: the unsigned delivery claimed NOTHING", rowsUnsigned === 0, `rows=${rowsUnsigned}`);
  leakScan("A3 forged-signature 400", forgedBody);
}

async function scenarioA4(hubLogPath) {
  if (!want("A4")) return;
  say("");
  say("=====================================================================");
  say("A4  payment ok, workspace creation fails  (partial fulfilment)");
  say("=====================================================================");
  const E = "evt_groupa_a4_0001";
  await admin.from("webhook_events").delete().eq("event_id", E);
  stripeApi.reset();
  globe.reset();
  stripeApi.checkoutSession = retrievedSession("cs_groupa_a4_0001", "a4@group-a.test", "user_groupa_a4");
  globe.provision.status = 500;
  globe.provision.body = '{"error":"group A injected provisioning failure"}';
  globe.tierSync.status = 200;

  const evt = checkoutEvent(E, "cs_groupa_a4_0001", "a4@group-a.test");
  const r = await deliver(evt);
  const rows = await ledger(E);
  say("");
  say(`[EVIDENCE A4] provisioning returned 500, tier-sync returned 200`);
  say(`[EVIDENCE A4] webhook HTTP ${r.status} ${r.body.slice(0, 160)}`);
  say(`[EVIDENCE A4] downstream hits = ${JSON.stringify(globe.hits.map((h) => `${h.path} -> cfg`))}`);
  say(`[EVIDENCE A4] /api/provision attempts = ${globe.count("/api/provision")}, /api/service/tier-sync attempts = ${globe.count("/api/service/tier-sync")}`);
  say(`[EVIDENCE A4] ledger row = ${JSON.stringify(rows[0] ?? null)}`);
  say(`[EVIDENCE A4] the ledger has NO column or row recording that provisioning failed; the only trace is the hub's log line`);
  block("hub log: provisioning failure", hubLog(hubLogPath, "Workspace provisioning FAILED"));
  check("A4: the webhook still answers 200 (Stripe is told all is well)", r.status === 200, `status=${r.status}`);
  check("A4: the tier sync was still attempted after provisioning failed", globe.count("/api/service/tier-sync") === 1, `tier hits=${globe.count("/api/service/tier-sync")}`);
  check("A4: the ledger records the event as fully completed", Boolean(rows[0]?.processed_at) && rows[0]?.last_error === null, JSON.stringify(rows[0] ?? null));
  const hasRemediation = rows[0] && Object.keys(rows[0]).some((k) => /provision|remediat|partial|unfulfilled/i.test(k));
  say(`[EVIDENCE A4] OPEN: the ledger cannot distinguish a fully-provisioned payment from a partial one (no such column: ${!hasRemediation})`);
}

async function scenarioA5(hubLogPath) {
  if (!want("A5")) return;
  say("");
  say("=====================================================================");
  say("A5  tier sync before the workspace exists  (404 -> ONE retry ->");
  say("    silent give-up)");
  say("=====================================================================");
  const E = "evt_groupa_a5_0001";
  await admin.from("webhook_events").delete().eq("event_id", E);
  stripeApi.reset();
  globe.reset();
  stripeApi.checkoutSession = retrievedSession("cs_groupa_a5_0001", "a5@group-a.test", "user_groupa_a5");
  globe.provision.status = 200;
  globe.tierSync.status = 404;
  globe.tierSync.body = '{"error":"Organization not found"}';

  const evt = checkoutEvent(E, "cs_groupa_a5_0001", "a5@group-a.test");
  const r = await deliver(evt);
  const rows = await ledger(E);
  const tierHits = globe.hits.filter((h) => h.path.includes("/api/service/tier-sync"));
  const gap = tierHits.length >= 2 ? tierHits[1].at - tierHits[0].at : null;
  say("");
  say(`[EVIDENCE A5] tier-sync answered 404 to every attempt`);
  say(`[EVIDENCE A5] webhook HTTP ${r.status} ${r.body.slice(0, 160)}`);
  say(`[EVIDENCE A5] tier-sync attempts = ${tierHits.length}; gap between attempt 1 and 2 = ${gap}ms`);
  say(`[EVIDENCE A5] ledger row = ${JSON.stringify(rows[0] ?? null)}`);
  block("hub log: tier sync failure", hubLog(hubLogPath, "Tier sync FAILED"));
  check("A5: exactly ONE retry is attempted (2 attempts total)", tierHits.length === 2, `attempts=${tierHits.length}`);
  check("A5: the retry waits ~500ms", gap !== null && gap >= 400 && gap <= 1500, `gap=${gap}ms`);
  check("A5: after giving up the webhook still answers 200", r.status === 200, `status=${r.status}`);
  check("A5: the ledger records the payment as fully completed despite the failed tier sync", Boolean(rows[0]?.processed_at) && rows[0]?.last_error === null, JSON.stringify(rows[0] ?? null));
  say(`[EVIDENCE A5] OPEN: the give-up leaves no durable record; the ledger's last_error/last_attempt_at columns stay NULL`);
}

async function scenarioA6(hubLogPath) {
  if (!want("A6")) return;
  say("");
  say("=====================================================================");
  say("A6  no account link  (paid checkout with no hub user identity)");
  say("=====================================================================");
  const E = "evt_groupa_a6_0001";
  await admin.from("webhook_events").delete().eq("event_id", E);
  stripeApi.reset();
  globe.reset();
  // The retrieved session carries neither metadata.userId nor client_reference_id:
  // the operator has no hub account to attach this payment to.
  stripeApi.checkoutSession = retrievedSession("cs_groupa_a6_0001", "a6@group-a.test", null);

  const evt = checkoutEvent(E, "cs_groupa_a6_0001", "a6@group-a.test");
  const r = await deliver(evt);
  const rows = await ledger(E);
  say("");
  say(`[EVIDENCE A6] webhook HTTP ${r.status} ${r.body.slice(0, 160)}`);
  say(`[EVIDENCE A6] /api/provision attempts = ${globe.count("/api/provision")} (provisioning is skipped entirely)`);
  say(`[EVIDENCE A6] /api/service/tier-sync attempts = ${globe.count("/api/service/tier-sync")}`);
  say(`[EVIDENCE A6] ledger row = ${JSON.stringify(rows[0] ?? null)}`);
  block("hub log: skipped provisioning", hubLog(hubLogPath, "SKIPPED workspace provisioning"));
  check("A6: the webhook answers 200 (the payment is accepted)", r.status === 200, `status=${r.status}`);
  check("A6: provisioning is skipped (nothing can be provisioned)", globe.count("/api/provision") === 0, `provision hits=${globe.count("/api/provision")}`);
  check("A6: a tier sync is still attempted", globe.count("/api/service/tier-sync") === 1, `tier hits=${globe.count("/api/service/tier-sync")}`);
  check("A6: the ledger records the event as completed", Boolean(rows[0]?.processed_at), JSON.stringify(rows[0] ?? null));
  say(`[EVIDENCE A6] OPEN: nothing durable names the affected account; the only remediation trail is an error-log line`);
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const hubLogPath = path.join(OUT_DIR, "_hub-dev.log");

  block("environment", [
    `hub worktree (the code under test) = ${HUB_CWD}`,
    `hub endpoint  = ${WEBHOOK_URL}`,
    `ledger        = ${SUPABASE_URL} (PostgREST -> Postgres public.webhook_events)`,
    `stand-in globe= ${GLOBE_URL}`,
    `stand-in Stripe (real stripe-node SDK) = http://127.0.0.1:${STRIPE_PORT}`,
    `scenarios     = ${ONLY.length ? ONLY.join(",") : "A1,A2,A3,A4,A5,A6"}`,
  ]);

  // Guard: the ledger must be the fixed two-state shape, or every A scenario is
  // measuring the pre-fix schema.
  const guard = await admin.from("webhook_events").select("event_id,last_error,last_attempt_at").limit(1);
  if (guard.error) {
    throw new Error(
      `ledger does not have the two-state schema (${guard.error.message}). ` +
        `Apply supabase/migrations/20260915000001_webhook_events_completion_state.sql first.`,
    );
  }
  say("[SETUP] ledger schema check OK: processed_at / last_error / last_attempt_at present");

  const globeServer = await startGlobe();
  const stripeServer = await startStripe();
  say(`[SETUP] stand-in globe + stand-in Stripe listening`);

  await ledgerCleanup();
  say(`[SETUP] removed any pre-existing evt_groupa_% rows so the run starts from a clean ledger`);

  try {
    await startHub(hubLogPath);
    await scenarioA1(hubLogPath);
    await scenarioA2(hubLogPath);
    await scenarioA3();
    await scenarioA4(hubLogPath);
    await scenarioA5(hubLogPath);
    await scenarioA6(hubLogPath);

    say("");
    block("final ledger state (all Group A fixture rows)", [
      JSON.stringify(
        await admin
          .from("webhook_events")
          .select("event_id,processed_at,last_error,last_attempt_at")
          .like("event_id", "evt_groupa_%")
          .order("event_id"),
        null,
        0,
      ),
    ]);
  } finally {
    stopHub();
    globeServer.close();
    stripeServer.close();
  }

  say("");
  say(`[SUMMARY] checks run = ${checks.length}, passed = ${checks.filter((c) => c.ok).length}, failed = ${failures.length}`);
  for (const f of failures) say(`[SUMMARY] FAILED: ${f}`);
  say(`GROUPA_RESULT ${JSON.stringify({ total: checks.length, failed: failures.length, failures })}`);
  fs.writeFileSync(path.join(OUT_DIR, "_groupa-harness.stdout.txt"), lines.join("\n") + "\n", "utf8");
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  say("");
  say(`[FATAL] ${err && err.stack ? err.stack : String(err)}`);
  say(`GROUPA_RESULT ${JSON.stringify({ total: checks.length, failed: failures.length + 1, fatal: String(err && err.message ? err.message : err) })}`);
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, "_groupa-harness.stdout.txt"), lines.join("\n") + "\n", "utf8");
  } catch {
    /* ignore */
  }
  stopHub();
  process.exit(1);
});
