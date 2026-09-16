import { crossServiceFetch } from "@/lib/cross-service/fetch";
import { asMessage } from "@/lib/billing/billing-tables";
import type { GlobePushResult, GlobeReadResult, GlobeTier } from "@/lib/billing/globe-tiers";

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
