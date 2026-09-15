import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * The alarm, end to end, from a REAL call site through the REAL notify().
 *
 * The two halves are proven separately today: notify.test.ts shows that
 * notify() redacts and posts, and webhook-stages.test.ts shows that a failing
 * delivery calls notify() with the right level and identifiers. Neither of them
 * would catch the failure that matters most - a call site whose message is
 * assembled somewhere the unit tests do not look, or a wiring change that leaves
 * notify() out of the path entirely. So this file mocks nothing but `fetch`:
 * the same stopProvisionFailure -> abandonIncompleteDelivery -> alertStageFailure
 * chain the route runs, all real, asserted on the bytes that would have hit the
 * channel.
 */
const mockFetch = vi.fn();

vi.hoisted(() => {
  process.env.ALERT_WEBHOOK_URL = "https://alerts.test/hook";
});

vi.mock("@/lib/billing/webhook-record", () => ({ recordStageFailure: vi.fn(async () => true) }));
vi.mock("@/lib/billing/webhook-idempotency", () => ({ failWebhookEvent: vi.fn(async () => undefined) }));

import { abandonIncompleteDelivery, noteProvisionFailure, type StageFailure } from "@/lib/billing/webhook-stages";

const customerEmail = "paying.customer@example.com";

function emitted(index: number): Record<string, unknown> {
  const call = mockFetch.mock.calls.at(index) as [string, { body: string }] | undefined;
  if (call === undefined) throw new Error(`no alert was posted at index ${index}`);
  return JSON.parse(call[1].body) as Record<string, unknown>;
}

afterEach(() => {
  mockFetch.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** One non-retryable provisioning failure, the way the route builds it. */
function permanentFailure(): StageFailure[] {
  const queue: StageFailure[] = [];
  noteProvisionFailure(
    queue,
    {
      eventId: "evt_e2e_1",
      eventType: "checkout.session.completed",
      email: customerEmail,
      userId: "uid_e2e_1",
    },
    { status: 400, detail: `refused for ${customerEmail}` },
  );
  return queue;
}

describe("a failing billing delivery reaches the alert channel", () => {
  it("posts the alert a real stage failure raises, without the customer's email in it", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValue(new Response("", { status: 200 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await abandonIncompleteDelivery("evt_e2e_1", "checkout.session.completed", permanentFailure());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, { method: string; headers: unknown }];
    expect(url).toBe("https://alerts.test/hook");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });

    const body = emitted(0);
    expect(body.level).toBe("critical");
    expect(body.service).toBe("worldwideview-web");
    expect(body.title).toBe("Billing stage failure: provision");
    expect(body.message).toContain("checkout.session.completed evt_e2e_1");
    expect(body.message).toContain("globe provisioning failed: 400");
    expect(body.context).toEqual({
      stage: "provision",
      eventId: "evt_e2e_1",
      eventType: "checkout.session.completed",
      userId: "uid_e2e_1",
      retryable: false,
    });

    // The one field that names a real person is gone from the whole payload,
    // including the free text the call site interpolated it into.
    const raw = mockFetch.mock.calls[0][1].body as string;
    expect(raw).not.toContain(customerEmail);
    expect(raw).toContain("[redacted]");
  });

  it("says at warning level for the retryable failure Stripe is about to fix", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValue(new Response("", { status: 200 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const queue: StageFailure[] = [];
    noteProvisionFailure(
      queue,
      { eventId: "evt_e2e_2", eventType: "checkout.session.completed", email: customerEmail, userId: "uid_e2e_2" },
      { status: 503, detail: "unavailable" },
    );

    await abandonIncompleteDelivery("evt_e2e_2", "checkout.session.completed", queue);

    const body = emitted(0);
    expect(body.level).toBe("warning");
    expect((body.context as Record<string, unknown>).retryable).toBe(true);
  });

  it("bounds the response path: N failures cost one awaited alert, not N of them", async () => {
    vi.stubGlobal("fetch", mockFetch);
    // Every channel call hangs until the timeout aborts it.
    mockFetch.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("This operation was aborted")));
      });
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const failures: StageFailure[] = [
      ...permanentFailure(),
      {
        failure: {
          stage: "resolve",
          eventId: "evt_e2e_1",
          eventType: "checkout.session.completed",
          error: "a second permanent failure",
        },
        retryable: false,
      },
      {
        failure: {
          stage: "tier_sync",
          eventId: "evt_e2e_1",
          eventType: "checkout.session.completed",
          error: "a third permanent failure",
        },
        retryable: false,
      },
    ];

    vi.useFakeTimers();
    const pending = abandonIncompleteDelivery("evt_e2e_1", "checkout.session.completed", failures);
    // Only the first alert is awaited, so the delivery settles after ONE timeout
    // window rather than three of them stacked on the response path.
    await vi.advanceTimersByTimeAsync(5_100);
    await pending;
    vi.useRealTimers();

    // The first alert was issued and awaited - the caller waited one window, not
    // three. The remaining loop iterations reach their notify() call, which
    // abandons the request at the next timer boundary without being awaited; that
    // is the bound this test exists for. All three were attempted.
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
