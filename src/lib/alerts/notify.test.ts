import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A configured webhook is the default here so that importing the module under
// test does not print its "no transport configured" warning in every test. The
// tests that care about that warning set the environment to empty themselves.
vi.hoisted(() => {
  process.env.ALERT_WEBHOOK_URL = "https://alerts.test/hook";
});

const mockFetch = vi.fn();

type Alerts = typeof import("@/lib/alerts/notify");

/**
 * Every test loads a FRESH copy of the module. The de-duplication window is
 * module-level state by design (it has to be shared by every caller in the
 * process), so reusing one instance across tests would let one test's alert
 * suppress the next test's.
 */
async function alerts(): Promise<Alerts> {
  return await import("@/lib/alerts/notify");
}

function ok() {
  return new Response("", { status: 200 });
}

function callAt(index: number): [string, Record<string, unknown>] {
  const call = mockFetch.mock.calls.at(index) as [string, Record<string, unknown>] | undefined;
  if (call === undefined) throw new Error(`no transport call was made at index ${index}`);
  return call;
}

function sentBody(index: number): string {
  return callAt(index)[1].body as string;
}

function payloadOf(index: number): Record<string, unknown> {
  return JSON.parse(sentBody(index)) as Record<string, unknown>;
}

beforeEach(() => {
  vi.resetModules();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(ok());
  vi.stubGlobal("fetch", mockFetch);
  // The webhook transport is on by default; ntfy has to be asked for.
  vi.stubEnv("NTFY_URL", "");
  vi.stubEnv("NTFY_TOPIC", "");
  // Installed up front so a test that disables every transport does not print the
  // module's load-time warning into the run; the two tests that assert on it reuse
  // this spy.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("alertingConfigured", () => {
  it("needs both ntfy values, because a topic without a server is not a channel", async () => {
    const { alertingConfigured } = await alerts();

    vi.stubEnv("ALERT_WEBHOOK_URL", "");
    expect(alertingConfigured()).toBe(false);

    vi.stubEnv("NTFY_URL", "https://ntfy.sh");
    expect(alertingConfigured()).toBe(false);

    vi.stubEnv("NTFY_TOPIC", "wwv-billing");
    expect(alertingConfigured()).toBe(true);
  });

  it("treats whitespace-only values as unset, so a blank Coolify variable disables the transport", async () => {
    const { alertingConfigured } = await alerts();

    vi.stubEnv("ALERT_WEBHOOK_URL", "   ");
    vi.stubEnv("NTFY_URL", " https://ntfy.sh ");
    vi.stubEnv("NTFY_TOPIC", "\t");

    expect(alertingConfigured()).toBe(false);
  });
});

describe("the payload each transport receives", () => {
  it("posts the JSON alert shape to ALERT_WEBHOOK_URL", async () => {
    const { notify } = await alerts();

    await notify("critical", "Billing ledger write lost", "The subscription record was not written.", {
      stage: "provision",
      eventId: "evt_1",
      retryable: false,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://alerts.test/hook");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(payloadOf(0)).toEqual({
      level: "critical",
      title: "Billing ledger write lost",
      message: "The subscription record was not written.",
      context: { stage: "provision", eventId: "evt_1", retryable: false },
      service: "worldwideview-web",
      timestamp: expect.any(String),
    });
    // A machine-readable timestamp, not a locale string: an alert that arrives
    // after the fact still has to be orderable against the logs.
    expect(new Date(payloadOf(0).timestamp as string).toISOString()).toBe(payloadOf(0).timestamp);
  });

  it("puts the topic in the ntfy URL and the title in the headers", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "");
    vi.stubEnv("NTFY_URL", "https://ntfy.sh/");
    vi.stubEnv("NTFY_TOPIC", "wwv-billing");
    const { notify } = await alerts();

    await notify("critical", "Billing webhook handling failed: checkout.session.completed", "globe 503");

    const [url, init] = mockFetch.mock.calls[0];
    // The trailing slash on the base is consumed, not doubled.
    expect(url).toBe("https://ntfy.sh/wwv-billing");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("globe 503");
    expect(init.headers).toEqual({
      "Content-Type": "text/plain",
      Title: "Billing webhook handling failed: checkout.session.completed",
      Priority: "urgent",
      Tags: "rotating_light",
    });
  });

  it("maps the level onto ntfy's priority, so an urgent alert is not delivered quietly", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "");
    vi.stubEnv("NTFY_URL", "https://ntfy.sh");
    vi.stubEnv("NTFY_TOPIC", "wwv-billing");
    const { notify } = await alerts();

    await notify("critical", "critical title", "m");
    await notify("warning", "warning title", "m");
    await notify("info", "info title", "m");

    expect(mockFetch.mock.calls.map((call) => call[1].headers.Priority)).toEqual(["urgent", "high", "default"]);
  });

  it("keeps a title with a newline out of the header, which would otherwise throw", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "");
    vi.stubEnv("NTFY_URL", "https://ntfy.sh/");
    vi.stubEnv("NTFY_TOPIC", "wwv-billing");
    const { notify } = await alerts();

    await expect(notify("critical", "line one\nline two\r\n", "m")).resolves.toBeUndefined();

    expect(mockFetch.mock.calls[0][1].headers.Title).toBe("line one line two");
  });

  it("sends to both transports when both are configured, because one silent channel is not a reason to lose the alert", async () => {
    vi.stubEnv("NTFY_URL", "https://ntfy.sh");
    vi.stubEnv("NTFY_TOPIC", "wwv-billing");
    const { notify } = await alerts();

    await notify("critical", "Billing ledger write lost", "m");

    expect(mockFetch.mock.calls.map((call) => call[0])).toEqual([
      "https://alerts.test/hook",
      "https://ntfy.sh/wwv-billing",
    ]);
    // The same suppression count rides both, and neither body is the other's.
    expect(sentBody(0)).toContain("m");
    expect(sentBody(1)).toBe("m");
  });
});

describe("never breaking the caller", () => {
  it("does nothing at all when no transport is configured", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "");
    const { notify } = await alerts();

    await expect(notify("critical", "t", "m", { eventId: "evt_1" })).resolves.toBeUndefined();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("swallows a transport that rejects, because a dead channel is a missing notification, not a second outage", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch.mockRejectedValue(new Error("getaddrinfo ENOTFOUND alerts.test"));
    const { notify } = await alerts();

    await expect(notify("critical", "t", "m")).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("webhook transport failed"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("ENOTFOUND"));
  });

  it("swallows a fetch that throws synchronously rather than rejecting", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch.mockImplementation(() => {
      throw new Error("fetch is not defined in this runtime");
    });
    const { notify } = await alerts();

    await expect(notify("critical", "t", "m")).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("webhook transport failed"));
  });

  it("swallows a non-2xx answer from the channel", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch.mockResolvedValue(new Response("nope", { status: 401 }));
    const { notify } = await alerts();

    await expect(notify("critical", "t", "m")).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("answered 401"));
  });

  it("does not let a failed channel stop the other one", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NTFY_URL", "https://ntfy.sh");
    vi.stubEnv("NTFY_TOPIC", "wwv-billing");
    mockFetch.mockRejectedValueOnce(new Error("webhook is down")).mockResolvedValueOnce(ok());
    const { notify } = await alerts();

    await expect(notify("critical", "t", "m")).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("webhook transport failed"));
  });

  it("warns once at load when nothing is configured, so silence is never mistaken for health", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await alerts();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No alert transport configured"));
  });

  it("stays silent at load when a transport is configured", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await alerts();

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("redaction", () => {
  it("never lets a customer email, a Stripe key or a signing secret reach the wire", async () => {
    const { notify } = await alerts();

    await notify(
      "critical",
      "Billing ledger write lost for pay@customer.com",
      "Contact pay@customer.com before retrying: whsec_abc123 and sk_live_secretkey were in scope.",
      {
        eventId: "evt_1",
        email: "pay@customer.com",
        apiKey: "sk_live_secretkey",
        note: "sent with Bearer abc.def.ghi",
      },
    );

    const body = sentBody(0);
    expect(body).not.toContain("pay@customer.com");
    expect(body).not.toContain("sk_live_secretkey");
    expect(body).not.toContain("whsec_abc123");
    expect(body).not.toContain("Bearer");
    expect(body).toContain("[redacted]");
    // Keys that name a secret are dropped outright; a clean value survives intact
    // but is scrubbed on the way through.
    expect(payloadOf(0).context).toEqual({ eventId: "evt_1", note: "sent with [redacted]" });
  });

  it("drops a nested value instead of serializing it, so nothing can bypass the key check", async () => {
    const { notify } = await alerts();

    await notify("critical", "t", "m", {
      eventId: "evt_1",
      // A caller that ignores the scalar-only type must not be able to smuggle a
      // customer object past the name-based check.
      leakedCustomer: { email: "pay@customer.com" } as unknown as string,
    });

    expect(payloadOf(0).context).toEqual({ eventId: "evt_1" });
    expect(sentBody(0)).not.toContain("pay@customer.com");
  });

  it("truncates an oversized field rather than posting a whole payload", async () => {
    const { notify } = await alerts();

    await notify("critical", "t", "x".repeat(4000));

    const message = payloadOf(0).message as string;
    expect(message.length).toBe(1503);
    expect(message.endsWith("...")).toBe(true);
  });
});

describe("de-duplication", () => {
  it("collapses identical alerts inside the window and reports the count on the next real send", async () => {
    vi.useFakeTimers();
    const { notify } = await alerts();
    const alert = () => notify("critical", "Billing stage failure: provision", "globe provisioning failed: 503");

    await alert();
    await alert();
    await alert();

    // A redelivery storm is one incident, not four pages.
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await alert();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(payloadOf(1).context).toEqual({ suppressedSinceLastSend: 2 });

    // The count is spent once it has been reported, so the next window starts clean.
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await alert();

    expect(payloadOf(2).context).toEqual({});
  });

  it("still sends a repeat that arrives after the window closes", async () => {
    vi.useFakeTimers();
    const { notify } = await alerts();

    await notify("critical", "t", "m");
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await notify("critical", "t", "m");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(payloadOf(1).context).toEqual({});
  });

  it("does not treat two different failures as one alert", async () => {
    const { notify } = await alerts();

    await notify("critical", "Billing stage failure: provision", "globe 503");
    await notify("critical", "Billing stage failure: tier_sync", "globe 503");
    await notify("warning", "Billing stage failure: provision", "globe 503");

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("spells the suppression count into the ntfy body, which has no context object", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ALERT_WEBHOOK_URL", "");
    vi.stubEnv("NTFY_URL", "https://ntfy.sh");
    vi.stubEnv("NTFY_TOPIC", "wwv-billing");
    const { notify } = await alerts();
    const alert = () => notify("warning", "Billing stage failure: tier_sync", "globe tier sync failed: 503");

    await alert();
    await alert();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await alert();

    expect(sentBody(1)).toBe("globe tier sync failed: 503\n\n(1 identical alert suppressed in the last 5 minutes)");
  });
});
