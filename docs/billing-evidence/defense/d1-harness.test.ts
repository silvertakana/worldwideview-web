// @vitest-environment node
/**
 * D1 reproduction harness for worldwideview-web (hub) origin/main @ 8d881c4.
 *
 * Copied into the worktree as temp/billing-defense-evidence/d1-harness.test.ts
 * by d1-reproduce.ps1. The harness never modifies product source.
 *
 * WHAT IS MOCKED vs REAL:
 *   mocked : @/lib/stripe/client      -> deterministic, offline Stripe surface
 *            server-only              -> not installed in the pnpm tree
 *   REAL   : @/lib/billing/webhook-idempotency  (real claimWebhookEvent)
 *   REAL   : @/lib/supabase/admin               (real supabase-js)
 *   REAL   : the local PostgREST + Postgres + the real
 *            supabase/migrations/20260806000001_create_webhook_events.sql DDL
 *   REAL   : @/lib/cross-service/fetch and @/lib/billing/provision, which are
 *            pointed at a live in-process HTTP counter instead of being mocked,
 *            so "did the handler do any downstream work" is answered by real
 *            observed network traffic rather than by a spy.
 *
 * The Stripe client is the only thing that is faked, and it is faked to throw
 * inside the switch, which is the failure mode named in the defect report.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { createClient } from "@supabase/supabase-js";

vi.hoisted(() => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.CROSS_SERVICE_SECRET = "test-cross-service-secret";
  process.env.STRIPE_PRO_PRICE_ID = "price_pro_monthly";
  process.env.STRIPE_PRO_ANNUAL_PRICE_ID = "price_pro_yearly";
  process.env.STRIPE_TEAM_MONTHLY_PRICE_ID = "price_team_monthly";
  process.env.STRIPE_TEAM_ANNUAL_PRICE_ID = "price_team_yearly";
});

const mocks = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  retrieveCheckoutSession: vi.fn(),
  retrieveCustomer: vi.fn(),
  retrieveSubscription: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    webhooks: { constructEvent: mocks.constructEvent },
    checkout: { sessions: { retrieve: mocks.retrieveCheckoutSession } },
    customers: { retrieve: mocks.retrieveCustomer },
    subscriptions: { retrieve: mocks.retrieveSubscription },
  }),
}));

import { POST } from "@/app/api/billing/webhook/route";

// ── Fixture: one checkout.session.completed event, fixed id, fixed bytes ──
const EVENT_ID = "evt_d1_repro_silent_payment_loss_0001";
const SIG = "t=1700000000,v1=deadbeefdeadbeefdeadbeefdeadbeef";

const REQUEST_BODY = JSON.stringify({
  id: EVENT_ID,
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_d1_repro_0001",
      client_reference_id: "user_d1_repro",
      customer: "cus_d1_repro",
      customer_email: "d1-repro@example.com",
      customer_details: { name: "D1 Repro", email: "d1-repro@example.com" },
      metadata: { userId: "user_d1_repro" },
      subscription: {
        id: "sub_d1_repro",
        trial_end: 1893456000,
        items: { data: [{ price: { id: "price_pro_monthly" } }] },
      },
    },
  },
});

function makeRequest(body: string): Request {
  return new Request("https://wwv.local:3001/api/billing/webhook", {
    method: "POST",
    headers: { "stripe-signature": SIG, "content-type": "application/json" },
    body,
  });
}

// ── Live downstream-work counter (real HTTP, not a spy) ──────────────
let counter: { hits: string[]; urls: string[]; bodies: string[] };
let server: Server;
let serverPort = 0;

function say(line: string) {
  // eslint-disable-next-line no-console
  console.log(line);
}

describe("D1: hub webhook claims the Stripe event before doing the work", () => {
  beforeAll(async () => {
    counter = { hits: [], urls: [], bodies: [] };
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        counter.hits.push(`${req.method} ${req.url}`);
        counter.urls.push(req.url ?? "");
        counter.bodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverPort = (server.address() as { port: number }).port;
    process.env.PROVISIONING_API_URL = `http://127.0.0.1:${serverPort}`;
    say(`[SETUP] live downstream counter listening on http://127.0.0.1:${serverPort}`);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("reproduces silent payment loss: 200 on throw, claim burned, redelivery a no-op", async () => {
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // Real ledger, real table. Clear only this harness's own fixture rows.
    await admin.from("webhook_events").delete().eq("event_id", EVENT_ID);
    const pre = await admin
      .from("webhook_events")
      .select("event_id", { count: "exact", head: true })
      .eq("event_id", EVENT_ID);
    say(`[PRE] webhook_events rows for ${EVENT_ID} BEFORE any delivery = ${pre.count ?? 0}`);

    // Deterministic throw INSIDE the switch, on the first outbound Stripe call.
    const event = JSON.parse(REQUEST_BODY);
    mocks.constructEvent.mockReturnValue(event);
    mocks.retrieveCheckoutSession.mockRejectedValue(
      new Error("SIMULATED_STRIPE_OUTAGE: stripe.checkout.sessions.retrieve threw"),
    );
    mocks.retrieveCustomer.mockRejectedValue(new Error("unused"));
    mocks.retrieveSubscription.mockRejectedValue(new Error("unused"));

    // Capture (and still print) the route's own error logging.
    const caught: string[] = [];
    const realConsoleError = console.error.bind(console);
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      caught.push(args.map(String).join(" "));
      realConsoleError(...args);
    });

    // ── Delivery 1 ────────────────────────────────────────────────────
    const res1 = await POST(makeRequest(REQUEST_BODY));
    const body1 = await res1.json();
    const downstreamAfter1 = counter.hits.slice();

    say("");
    say(`[EVIDENCE D1.a] delivery 1 HTTP status = ${res1.status}`);
    say(`[EVIDENCE D1.a] delivery 1 body = ${JSON.stringify(body1)}`);
    say(`[EVIDENCE D1.a] route reached its catch block = ${caught.some((m) => m.includes("Error handling checkout.session.completed"))}`);
    say(`[EVIDENCE D1.a] stripe.checkout.sessions.retrieve calls = ${mocks.retrieveCheckoutSession.mock.calls.length}`);
    say(`[EVIDENCE D1.a] downstream globe calls during delivery 1 = ${downstreamAfter1.length} ${JSON.stringify(downstreamAfter1)}`);

    const row1 = await admin
      .from("webhook_events")
      .select("event_id, processed_at")
      .eq("event_id", EVENT_ID)
      .maybeSingle();
    say(`[EVIDENCE D1.b] webhook_events row after the failed, 200-answering delivery = ${JSON.stringify(row1.data)}`);
    say(`[EVIDENCE D1.b] the ledger records no outcome field; processed_at is already set`);
    say(`[EVIDENCE D1.b] rows visible for this event = ${row1.data ? 1 : 0}`);

    // ── Delivery 2: byte-identical redelivery ─────────────────────────
    const res2 = await POST(makeRequest(REQUEST_BODY));
    const body2 = await res2.json();
    const downstreamAfter2 = counter.hits.slice();
    const sameBytes =
      mocks.constructEvent.mock.calls[0]?.[0] === mocks.constructEvent.mock.calls[1]?.[0];

    say("");
    say(`[EVIDENCE D1.c] redelivery used byte-identical request body = ${sameBytes}`);
    say(`[EVIDENCE D1.c] delivery 2 HTTP status = ${res2.status}`);
    say(`[EVIDENCE D1.c] delivery 2 body = ${JSON.stringify(body2)}`);
    say(`[EVIDENCE D1.c] stripe.checkout.sessions.retrieve calls after both deliveries = ${mocks.retrieveCheckoutSession.mock.calls.length}`);
    say(`[EVIDENCE D1.c] downstream globe calls after both deliveries = ${downstreamAfter2.length} ${JSON.stringify(downstreamAfter2)}`);
    say(`[EVIDENCE D1.c] provisioning attempts after both deliveries = ${counter.urls.filter((u) => u.includes("/api/provision")).length}`);
    say(`[EVIDENCE D1.c] tier-sync attempts after both deliveries = ${counter.urls.filter((u) => u.includes("/api/service/tier-sync")).length}`);

    const total = await admin
      .from("webhook_events")
      .select("event_id", { count: "exact", head: true })
      .eq("event_id", EVENT_ID);
    say(`[EVIDENCE D1.d] final webhook_events rows for this event = ${total.count ?? 0}`);
    say("");

    // ── Assertions: each one asserts the defect, so a green run proves it ──
    expect(res1.status, "delivery 1 answers 200 even though the handler threw").toBe(200);
    expect(body1).toEqual({ received: true });
    expect(
      caught.some((m) => m.includes("Error handling checkout.session.completed")),
      "the switch catch block ran (the throw was swallowed)",
    ).toBe(true);
    expect(row1.data?.event_id, "the event id is claimed in the ledger").toBe(EVENT_ID);
    expect(row1.data?.processed_at, "processed_at is set by the claim itself").toBeTruthy();
    expect(downstreamAfter1, "no provisioning and no tier sync happened").toHaveLength(0);

    expect(res2.status, "the redelivery also answers 200").toBe(200);
    expect(body2, "the redelivery reports duplicate:true").toEqual({
      received: true,
      duplicate: true,
    });
    expect(sameBytes, "the two deliveries were byte-identical").toBe(true);
    expect(
      mocks.retrieveCheckoutSession.mock.calls.length,
      "the redelivery did not even attempt the Stripe retrieve",
    ).toBe(1);
    expect(downstreamAfter2, "the redelivery performed no downstream work either").toHaveLength(0);
    expect(total.count, "exactly one ledger row exists; nothing marks the payment unfulfilled").toBe(1);
  }, 60000);
});
