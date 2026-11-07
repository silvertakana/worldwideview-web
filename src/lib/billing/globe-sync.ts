import { crossServiceFetch } from "@/lib/cross-service/fetch";
import { asMessage } from "@/lib/billing/billing-tables";
import type { GlobePushResult, GlobeReadResult, GlobeTier } from "@/lib/billing/globe-tiers";
import type {
  GlobeKeyUsage,
  GlobeToolUsage,
  GlobeUsage,
  GlobeUsageReadResult,
} from "@/lib/billing/globe-usage";

/**
 * The two calls that talk to the globe. The vocabulary they speak - GLOBE_TIERS,
 * the failure kinds, the result shapes - lives in globe-tiers.ts, which stays
 * free of the signer this module needs.
 *
 * This is the only path that changes a customer's real access: the hub's own
 * tables record a decision, but the globe's org_tiers row (and the workspace lock
 * it drives) is what the customer feels.
 */

async function readJsonBody(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function messageFrom(body: Record<string, unknown> | null, fallback: string): string {
  return text(body?.error, fallback);
}

/**
 * Mirrors a tier onto the globe.
 *
 * `periodEndsAt` is deliberately NOT sent even though the endpoint ignores extra
 * fields: the globe's route never reads it, so sending it would imply an expiry
 * the globe does not honour.
 */
export async function pushTierToGlobe(input: { email: string; tier: GlobeTier }): Promise<GlobePushResult> {
  try {
    const res = await crossServiceFetch("/api/service/tier-sync", {
      method: "POST",
      body: { email: input.email, tier: input.tier, status: "active" },
    });
    const body = await readJsonBody(res);

    if (res.ok) {
      return { ok: true, detail: `The globe now grants "${input.tier}" for ${input.email}.` };
    }
    if (res.status === 404) {
      return {
        ok: false,
        failure: "no-organization",
        detail:
          `The globe has no organization for ${input.email}, so there was nowhere to write the tier. ` +
          "The customer needs a globe workspace before any tier can reach them.",
      };
    }
    if (res.status === 400) {
      return {
        ok: false,
        failure: "rejected",
        detail: `The globe rejected the request: ${messageFrom(body, "400 Bad Request")}`,
      };
    }
    if (res.status === 401) {
      return {
        ok: false,
        failure: "unreachable",
        detail:
          "The globe refused our cross-service signature (401 Unauthorized): CROSS_SERVICE_SECRET " +
          "does not match between the hub and the globe.",
      };
    }
    return {
      ok: false,
      failure: "unreachable",
      detail: `The globe answered ${res.status}: ${messageFrom(body, "no message")}`,
    };
  } catch (err) {
    return { ok: false, failure: "unreachable", detail: `Could not reach the globe: ${asMessage(err)}` };
  }
}

/**
 * The globe's own view of the customer's tier - the mirror the customer actually
 * feels. Read before a grant so the operator learns *before* acting that a
 * customer has no globe organization, instead of discovering it from a failure.
 */
export async function readGlobeTier(email: string): Promise<GlobeReadResult> {
  try {
    const res = await crossServiceFetch("/api/service/tier", { searchParams: { email } });
    const body = await readJsonBody(res);

    if (res.ok && body) {
      return {
        ok: true,
        state: {
          tier: text(body.tier, "unknown"),
          status: text(body.status, "unknown"),
          effectiveTier: text(body.effectiveTier, text(body.tier, "unknown")),
          effectiveStatus: text(body.effectiveStatus, text(body.status, "unknown")),
          instanceCount: typeof body.instanceCount === "number" ? body.instanceCount : 0,
        },
      };
    }
    if (res.status === 404) {
      return {
        ok: false,
        failure: "no-organization",
        detail: "The globe has no organization for this email, so a tier push will fail until one exists.",
      };
    }
    return {
      ok: false,
      failure: "unreachable",
      detail: `The globe answered ${res.status}: ${messageFrom(body, "no message")}`,
    };
  } catch (err) {
    return { ok: false, failure: "unreachable", detail: `Could not reach the globe: ${asMessage(err)}` };
  }
}

/** One tool row from the globe, or null when the row does not carry the fields. */
function toolUsageFrom(value: unknown): GlobeToolUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.toolName !== "string" || typeof row.calls !== "number") return null;
  return {
    toolName: row.toolName,
    calls: row.calls,
    lastCallAt: typeof row.lastCallAt === "string" ? row.lastCallAt : null,
  };
}

/** One key row from the globe, or null when the row does not carry the fields. */
function keyUsageFrom(value: unknown): GlobeKeyUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.keyId !== "string" || typeof row.calls !== "number") return null;
  const tools = Array.isArray(row.tools)
    ? row.tools.map(toolUsageFrom).filter((tool): tool is GlobeToolUsage => tool !== null)
    : [];
  return {
    keyId: row.keyId,
    userId: typeof row.userId === "string" ? row.userId : null,
    name: typeof row.name === "string" ? row.name : null,
    prefix: typeof row.prefix === "string" ? row.prefix : null,
    calls: row.calls,
    tools,
  };
}

/**
 * What the customer's keys actually called this period, read from the globe.
 *
 * Shaped exactly like readGlobeTier, including the 404 mapping, because the hub
 * already speaks that vocabulary: 404 is "there is no account here", 401 is "our
 * signature is wrong", anything else is "we could not talk to the globe".
 *
 * A malformed body is 'unreachable' rather than a zero-call answer. A body that
 * cannot be read and a month with no calls look identical to a caller that
 * defaults, and only one of them is a number you may invoice.
 *
 * `period` is "YYYY-MM"; omitting it asks the globe for the current UTC month,
 * which is what a live screen wants and what an invoice run must never rely on.
 * Omitting `email` asks for every key in the period, which only a signed caller
 * can do.
 */
export async function readGlobeUsage(input: {
  email?: string;
  period?: string;
} = {}): Promise<GlobeUsageReadResult> {
  const searchParams: Record<string, string> = {};
  if (input.email) searchParams.email = input.email;
  if (input.period) searchParams.period = input.period;

  try {
    const res = await crossServiceFetch("/api/service/usage", { searchParams });
    const body = await readJsonBody(res);

    if (res.ok && body) {
      const period = body.period as Record<string, unknown> | undefined;
      const keys = Array.isArray(body.keys)
        ? body.keys.map(keyUsageFrom).filter((key): key is GlobeKeyUsage => key !== null)
        : null;

      if (
        !period ||
        typeof period.start !== "string" ||
        typeof period.end !== "string" ||
        typeof period.label !== "string" ||
        keys === null ||
        typeof body.totalCalls !== "number"
      ) {
        return {
          ok: false,
          failure: "unreachable",
          detail:
            "The globe answered 200 with a body that does not carry a period and a key list, so " +
            "this is not a usage number: an unreadable body must not be invoiced as zero calls.",
        };
      }

      const usage: GlobeUsage = {
        period: { start: period.start, end: period.end, label: period.label },
        keys,
        totalCalls: body.totalCalls,
        toolTotals: Array.isArray(body.toolTotals)
          ? body.toolTotals
              .map((entry) => {
                if (typeof entry !== "object" || entry === null) return null;
                const row = entry as Record<string, unknown>;
                if (typeof row.toolName !== "string" || typeof row.calls !== "number") return null;
                return { toolName: row.toolName, calls: row.calls };
              })
              .filter((entry): entry is { toolName: string; calls: number } => entry !== null)
          : [],
      };

      return { ok: true, usage };
    }

    if (res.status === 404) {
      return {
        ok: false,
        failure: "no-organization",
        detail: input.email
          ? `The globe has no account for ${input.email}, so it holds no usage for that address.`
          : "The globe has no account for this address, so it holds no usage for it.",
      };
    }
    if (res.status === 401) {
      return {
        ok: false,
        failure: "unreachable",
        detail:
          "The globe refused our cross-service signature (401 Unauthorized): CROSS_SERVICE_SECRET " +
          "does not match between the hub and the globe.",
      };
    }
    return {
      ok: false,
      failure: "unreachable",
      detail: `The globe answered ${res.status}: ${messageFrom(body, "no message")}`,
    };
  } catch (err) {
    return { ok: false, failure: "unreachable", detail: `Could not reach the globe: ${asMessage(err)}` };
  }
}
