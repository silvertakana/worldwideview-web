import { crossServiceFetch } from "@/lib/cross-service/fetch";

export interface ProvisionResult {
  ok: boolean;
  status?: number;
  detail?: string;
}

/**
 * Local part of an email, sanitized into a globe-safe slug: lowercase,
 * alphanumeric + hyphens only, capped at 63 chars (DNS label limit). Falls
 * back to "user" for degenerate inputs like "@example.com".
 */
export function subdomainFromEmail(email: string): string {
  const local = (email.split("@")[0] || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
  return local || "user";
}

/** Display name for the workspace org, derived from the email when Stripe has none. */
export function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] || "";
  const display = local.charAt(0).toUpperCase() + local.slice(1);
  return display || email;
}

/**
 * Best-effort globe workspace provisioning for a newly paying hub user.
 *
 * Calls the globe's HMAC-protected /api/provision endpoint directly — the same
 * call the hub's auth-gated POST /api/provisioning/workspace route forwards.
 * The webhook cannot go through that route because it requires a Supabase
 * session cookie, which a Stripe-invoked webhook does not have.
 *
 * The globe endpoint is idempotent: an existing user gets a fresh setup token
 * instead of a 409, so duplicate checkout.session.completed deliveries are
 * safe. `subdomain` is passed for parity with the provisioning route's forward
 * call; the globe derives its org slug from the email itself and ignores it.
 */
export async function provisionWorkspace(opts: {
  email: string;
  hubUserId: string;
  subdomain?: string;
  name?: string;
}): Promise<ProvisionResult> {
  const { email, hubUserId } = opts;
  const subdomain = opts.subdomain ?? subdomainFromEmail(email);
  const name = opts.name ?? displayNameFromEmail(email);
  try {
    const res = await crossServiceFetch("/api/provision", {
      method: "POST",
      body: { email, name, hubUserId, subdomain },
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 160);
      return { ok: false, status: res.status, detail };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
