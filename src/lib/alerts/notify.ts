/**
 * Operator alerting (D9): the failures that have to reach a human, not just a log.
 *
 * Every serious failure on the billing path already has a console.error next to
 * it, and a log line nobody is watching is not a notification. This module is the
 * one place the hub pushes a failure to a channel the owner actually reads. It is
 * deliberately dependency-free - no Sentry, no analytics SDK, no queue - because
 * the hub has none of those today and a paid customer with no workspace is the
 * wrong reason to acquire one. Two transports, both a plain HTTP POST, both
 * configured purely by environment variables, so a deployment that configures
 * neither behaves exactly as it does now.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE. An alert must never be able to break the
 * thing that raised it, and must never be able to leak. The failures worth
 * alerting on arrive with a live Stripe event, a customer email and sometimes a
 * signing secret in scope, which drives every decision below:
 *
 *   - notify() never throws and never rejects. A dead alert channel is a missing
 *     notification, not a second outage: every failure inside this module is
 *     swallowed into a log line.
 *   - critical alerts are awaited, because the caller has nothing left to do and
 *     the process must not move on before the POST leaves. warning and info are
 *     fire-and-forget, so a webhook response is never held up by a slow channel.
 *   - there is no retry and no backoff. A retrying alerter amplifies the exact
 *     incident it is reporting, and the call site still logs regardless.
 *   - every outbound string is scrubbed. Customer emails, tokens, signing secrets
 *     and Authorization headers never leave the process. Callers pass identifiers
 *     (ids, stages, statuses, counts), never payloads.
 *   - identical alerts are collapsed inside a rolling window, because the failures
 *     that matter most arrive as a redelivery storm: Stripe retries a 500 on its
 *     own schedule, so one broken event can raise the same alert six times inside
 *     a minute. The suppressed count rides the next real send instead of being
 *     silently dropped.
 *
 * WHAT THE DE-DUPLICATION ACTUALLY IS, because the honest answer is narrower than
 * "identical alerts are collapsed". The window lives in this module's process
 * memory, so the guarantee is one send per window PER PROCESS, not per platform.
 * The hub runs a single server process (see ADR-0010), which makes those the same
 * thing: Stripe's redeliveries all reach this one window, and an identical alert
 * inside it is collapsed exactly as described above. Running several containers
 * would reopen the gap - an identical alert landing on a different process is NOT
 * collapsed, and the ceiling becomes one send per process per window. Sharing the
 * state would mean Redis, a table or a sticky-routing rule, and none of those are
 * worth acquiring to make an alert quieter: a few POSTs is not the failure mode
 * this module exists to prevent. Always compare the collapse against the ledger
 * rows, which are shared and authoritative.
 *
 * Server-only: it reads process.env at call time and must never be imported from
 * a client component.
 */

export type AlertLevel = "critical" | "warning" | "info";

/** Scalar-only, so the payload stays flat and nothing nested can carry a secret. */
export type AlertContext = Record<string, string | number | boolean | null | undefined>;

/** The JSON body posted to ALERT_WEBHOOK_URL. */
export interface AlertPayload {
  level: AlertLevel;
  title: string;
  message: string;
  context: Record<string, string | number | boolean>;
  service: "worldwideview-web";
  timestamp: string;
}

const SERVICE = "worldwideview-web";
const ALERT_TIMEOUT_MS = 5_000;
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const DEDUPE_WINDOW_MINUTES = DEDUPE_WINDOW_MS / 60_000;
const MAX_TRACKED_KEYS = 500;
const MAX_FIELD_CHARS = 1_500;
const REDACTED = "[redacted]";
/** One line a minute per worker: enough to see the drop, not enough to become the flood. */
const DROP_LOG_INTERVAL_MS = 60_000;

/** Which transports a deployment has actually configured. Names only, never values. */
export type AlertingTransport = "webhook" | "ntfy";

/**
 * "partially-configured" is its own state, not a rounding of "unconfigured": a
 * topic with no server, or a server with no topic, is a deployment that believes
 * it is alerting and is not. That is the case an operator most needs to see.
 */
export type AlertingStatus = "configured" | "partially-configured" | "unconfigured";

export interface AlertingConfigState {
  status: AlertingStatus;
  /** Transport names that would actually carry an alert right now. */
  transports: AlertingTransport[];
  /** Names of the variables that are set but not enough on their own. */
  incomplete: string[];
}

export function alertingConfigState(): AlertingConfigState {
  const hasWebhook = webhookUrl() !== "";
  const hasNtfyBase = ntfyBaseUrl() !== "";
  const hasNtfyTopic = ntfyTopic() !== "";

  const transports: AlertingTransport[] = [];
  if (hasWebhook) transports.push("webhook");
  if (hasNtfyBase && hasNtfyTopic) transports.push("ntfy");

  const incomplete: string[] = [];
  if (hasNtfyBase !== hasNtfyTopic) incomplete.push(hasNtfyBase ? "NTFY_TOPIC" : "NTFY_URL");

  const status: AlertingStatus =
    transports.length > 0 ? "configured" : incomplete.length > 0 ? "partially-configured" : "unconfigured";

  return { status, transports, incomplete };
}

function webhookUrl(): string {
  return (process.env.ALERT_WEBHOOK_URL ?? "").trim();
}

function ntfyBaseUrl(): string {
  return (process.env.NTFY_URL ?? "").trim();
}

function ntfyTopic(): string {
  return (process.env.NTFY_TOPIC ?? "").trim();
}

/** Whether any transport is configured. Both NTFY_ values are required together. */
export function alertingConfigured(): boolean {
  return webhookUrl() !== "" || (ntfyBaseUrl() !== "" && ntfyTopic() !== "");
}

/**
 * Secret-shaped VALUES, scrubbed wherever they appear.
 *
 * The key-based check below only sees context KEYS; these patterns are the net
 * under the free-text title and message, where an error string can carry a card
 * number or a signing secret without anyone having meant to put it there.
 */
const SECRET_PATTERNS: RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // email addresses
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]+/g, // Stripe API keys
  /\bwhsec_[A-Za-z0-9]+/g, // Stripe webhook signing secrets
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, // bearer tokens
  /\beyJ[A-Za-z0-9._-]{10,}/g, // JWT-shaped values
];

/**
 * Context KEYS whose value is never sent. Deliberately over-broad: dropping a
 * benign field costs an operator nothing, and leaking an apiKey costs everything.
 * Matching is on the normalized key, so `api-key`, `apiKey` and `API_KEY` all land.
 */
const FAIL_CLOSED_KEY_NEEDLES = [
  "email",
  "secret",
  "token",
  "password",
  "passwd",
  "credential",
  "apikey",
  "key",
  "authorization",
  "bearer",
  "cookie",
  "card",
  "cvc",
  "iban",
  "signature",
  "session",
  "body",
  "payload",
];

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return FAIL_CLOSED_KEY_NEEDLES.some((needle) => normalized.includes(needle));
}

function scrub(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out.length > MAX_FIELD_CHARS ? `${out.slice(0, MAX_FIELD_CHARS)}...` : out;
}

/** HTTP headers are latin-1 and single-line, so a title with a newline would throw. */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[^\x20-\x7e]/g, "").slice(0, 200).trim();
}

interface Transport {
  name: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

function ntfyPriority(level: AlertLevel): string {
  if (level === "critical") return "urgent";
  if (level === "warning") return "high";
  return "default";
}

function ntfyTags(level: AlertLevel): string {
  if (level === "critical") return "rotating_light";
  if (level === "warning") return "warning";
  return "information_source";
}

/** The ntfy body is plain text, so the suppression count has to be spelled into it. */
function ntfyBody(payload: AlertPayload): string {
  const suppressed = payload.context.suppressedSinceLastSend;
  if (typeof suppressed !== "number" || suppressed === 0) return payload.message;
  const noun = suppressed === 1 ? "identical alert" : "identical alerts";
  return `${payload.message}\n\n(${suppressed} ${noun} suppressed in the last ${DEDUPE_WINDOW_MINUTES} minutes)`;
}

function transportsFor(payload: AlertPayload): Transport[] {
  const out: Transport[] = [];

  const url = webhookUrl();
  if (url !== "") {
    out.push({
      name: "webhook",
      url,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  const base = ntfyBaseUrl();
  const topic = ntfyTopic();
  if (base !== "" && topic !== "") {
    out.push({
      name: "ntfy",
      url: `${base.replace(/\/+$/, "")}/${encodeURIComponent(topic)}`,
      headers: {
        "Content-Type": "text/plain",
        Title: headerSafe(payload.title),
        Priority: ntfyPriority(payload.level),
        Tags: ntfyTags(payload.level),
      },
      body: ntfyBody(payload),
    });
  }

  return out;
}

interface DedupeEntry {
  lastSentAt: number;
  suppressed: number;
}

const tracked = new Map<string, DedupeEntry>();

/**
 * Returns the number of identical alerts suppressed since the last real send, or
 * null when this one is itself suppressed.
 *
 * Eviction is bounded and keeps the NEWEST keys. Clearing the map at capacity
 * would be the worst possible moment to do it: a full window means a burst of
 * distinct failures, and dropping every entry re-sends all of them at once - the
 * dedupe would fail exactly when the storm it exists for is happening. Evicting
 * the oldest quarter keeps the most recently seen keys, which are the ones a
 * redelivery storm is still arriving on.
 */
function claimSendSlot(key: string, now: number): number | null {
  const entry = tracked.get(key);
  if (entry !== undefined && now - entry.lastSentAt < DEDUPE_WINDOW_MS) {
    entry.suppressed += 1;
    return null;
  }
  const suppressed = entry?.suppressed ?? 0;
  if (tracked.size >= MAX_TRACKED_KEYS) {
    for (const [candidate, seen] of tracked) {
      if (now - seen.lastSentAt >= DEDUPE_WINDOW_MS) tracked.delete(candidate);
    }
    if (tracked.size >= MAX_TRACKED_KEYS) {
      const oldestFirst = [...tracked].sort((a, b) => a[1].lastSentAt - b[1].lastSentAt);
      for (let i = 0; i < MAX_TRACKED_KEYS / 4 && i < oldestFirst.length; i += 1) {
        tracked.delete(oldestFirst[i][0]);
      }
    }
  }
  tracked.set(key, { lastSentAt: now, suppressed: 0 });
  return suppressed;
}

function safeContext(context: AlertContext, suppressed: number): Record<string, string | number | boolean> {
  const entries: Array<[string, string | number | boolean]> = [];
  for (const [key, value] of Object.entries(context)) {
    if (isSecretKey(key) || value === null || value === undefined) continue;
    if (typeof value === "string") entries.push([key, scrub(value)]);
    else if (typeof value === "boolean") entries.push([key, value]);
    else if (typeof value === "number" && Number.isFinite(value)) entries.push([key, value]);
    // Anything else (object, array, NaN) is dropped rather than serialized: the
    // payload stays flat, so no nested value can bypass the key check above.
  }
  if (suppressed > 0) entries.push(["suppressedSinceLastSend", suppressed]);
  return Object.fromEntries(entries);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let lastDropLogAt = 0;

/**
 * Says, at the point of failure, that this alert is going nowhere.
 *
 * The load-time warning below fires once per process, before any request exists,
 * and lands in the same container logs as the console.error this module was built
 * to replace. An operator reading the health endpoint sees the standing state; a
 * log line per drop is what ties a specific incident to it. Rate-limited per
 * worker so a storm cannot turn the alerting path into its own flood.
 *
 * Variable NAMES only. Values are secrets and never appear here.
 */
function logDroppedAlert(level: AlertLevel, title: string, now: number): void {
  if (now - lastDropLogAt < DROP_LOG_INTERVAL_MS) return;
  lastDropLogAt = now;
  const { status, incomplete } = alertingConfigState();
  const missing =
    incomplete.length > 0
      ? `set ${incomplete.join(", ")} as well`
      : "set ALERT_WEBHOOK_URL, or NTFY_URL and NTFY_TOPIC";
  console.warn(
    `[alerts] DROPPED a ${level} alert ("${title}"): no transport is configured (${status}). To receive it, ${missing}. At most one of these lines is printed per worker per minute; the health endpoint at /api/health reports the standing state.`,
  );
}

async function deliver(transport: Transport): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);
  try {
    const res = await fetch(transport.url, {
      method: "POST",
      headers: transport.headers,
      body: transport.body,
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[alerts] ${transport.name} transport answered ${res.status}; the alert was not delivered`);
    }
  } catch (err) {
    console.error(`[alerts] ${transport.name} transport failed: ${describe(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Raises one operator alert.
 *
 * `context` carries identifiers only - ids, stages, HTTP statuses, counts. Do not
 * pass a Stripe payload, an event object or a request body: emails and secrets are
 * stripped by the checks above, but a payload that never had them to begin with is
 * the only version of this that stays true as the callers change.
 */
export async function notify(
  level: AlertLevel,
  title: string,
  message: string,
  context: AlertContext = {},
): Promise<void> {
  try {
    const safeTitle = scrub(title);
    const safeMessage = scrub(message);
    const suppressed = claimSendSlot(`${level}\u0000${safeTitle}\u0000${safeMessage}`, Date.now());
    if (suppressed === null) return;

    const payload: AlertPayload = {
      level,
      title: safeTitle,
      message: safeMessage,
      context: safeContext(context, suppressed),
      service: SERVICE,
      timestamp: new Date().toISOString(),
    };

    const transports = transportsFor(payload);
    if (transports.length === 0) {
      // Deliberately AFTER the dedupe slot is claimed: the claim spends the
      // suppression count, so a drop that did not claim would silently merge into
      // the next real send's "N suppressed" and read as a delivery that happened.
      logDroppedAlert(level, safeTitle, Date.now());
      return;
    }

    const pending = Promise.all(transports.map(deliver));
    if (level === "critical") {
      await pending;
    }
    // warning/info deliberately fall through without awaiting: deliver() can
    // neither throw nor reject, and a webhook response must not wait on a channel.
  } catch (err) {
    console.error(`[alerts] Dropped a ${level} alert ("${title}"): ${describe(err)}`);
  }
}

if (!alertingConfigured()) {
  console.warn(
    "[alerts] No alert transport configured (ALERT_WEBHOOK_URL, or NTFY_URL + NTFY_TOPIC); every alert will be dropped. /api/health reports this as alerting.unconfigured.",
  );
}
