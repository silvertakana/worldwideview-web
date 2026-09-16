import { describe, it, expect, vi, afterEach } from "vitest";

import { GET } from "@/app/api/health/route";

/**
 * The health endpoint is the only place an operator can SEE, from outside the
 * container, whether billing alerts have anywhere to go. The point of these
 * tests is the pairing: the alerting state must be reported, and it must never
 * change the health verdict itself - a hub that runs correctly but has no alert
 * channel is not unhealthy, and a deploy check that reads `status` must not go
 * red because of it.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

async function body(): Promise<Record<string, unknown>> {
  const response = GET();
  return (await response.json()) as Record<string, unknown>;
}

describe("GET /api/health", () => {
  it("keeps status ok when alerting is configured", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://alerts.test/hook");
    vi.stubEnv("NTFY_URL", "");
    vi.stubEnv("NTFY_TOPIC", "");

    expect(await body()).toEqual({
      status: "ok",
      alerting: { status: "configured", transports: ["webhook"], incomplete: [] },
    });
  });

  it("keeps status ok when alerting is NOT configured, and says so", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "");
    vi.stubEnv("NTFY_URL", "");
    vi.stubEnv("NTFY_TOPIC", "");

    const payload = await body();

    // Not a health failure: the route contract is unchanged.
    expect(payload.status).toBe("ok");
    expect(payload.alerting).toEqual({ status: "unconfigured", transports: [], incomplete: [] });
  });

  it("reports the half-configured deployment that thinks it is alerting", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "");
    vi.stubEnv("NTFY_URL", "https://ntfy.sh");
    vi.stubEnv("NTFY_TOPIC", "");

    expect(await body()).toEqual({
      status: "ok",
      alerting: { status: "partially-configured", transports: [], incomplete: ["NTFY_TOPIC"] },
    });
  });

  it("names the transports in play without disclosing any configured value", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://alerts.test/hook");
    vi.stubEnv("NTFY_URL", "https://ntfy.sh");
    vi.stubEnv("NTFY_TOPIC", "wwv-billing-secret-topic");

    const serialized = JSON.stringify(await body());

    expect(serialized).toContain("ntfy");
    expect(serialized).not.toContain("wwv-billing-secret-topic");
    expect(serialized).not.toContain("alerts.test");
    expect(serialized).not.toContain("ntfy.sh");
  });

  it("reports the alerting state fresh on every request, because it is read from the environment at call time", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "");
    vi.stubEnv("NTFY_URL", "");
    vi.stubEnv("NTFY_TOPIC", "");
    expect((await body()).alerting).toMatchObject({ status: "unconfigured" });

    vi.stubEnv("ALERT_WEBHOOK_URL", "https://alerts.test/hook");
    expect((await body()).alerting).toMatchObject({ status: "configured" });
  });
});
