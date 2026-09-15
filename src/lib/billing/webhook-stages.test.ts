import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRecordStageFailure, mockFailWebhookEvent } = vi.hoisted(() => ({
  mockRecordStageFailure: vi.fn(),
  mockFailWebhookEvent: vi.fn(),
}));

vi.mock("@/lib/billing/webhook-record", () => ({ recordStageFailure: mockRecordStageFailure }));
vi.mock("@/lib/billing/webhook-idempotency", () => ({ failWebhookEvent: mockFailWebhookEvent }));

import {
  abandonIncompleteDelivery,
  isRetryableStageFailure,
  noteMissingHubUserId,
  noteProvisionFailure,
  noteTierSyncFailure,
  shouldAskStripeToRetry,
  type StageFailure,
  type StageFailureContext,
} from "@/lib/billing/webhook-stages";

const context: StageFailureContext = {
  eventId: "evt_1",
  eventType: "customer.subscription.deleted",
  email: "cancel@example.com",
  userId: "uid_1",
};

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockRecordStageFailure.mockReset();
  mockFailWebhookEvent.mockReset();
  mockRecordStageFailure.mockResolvedValue(true);
  mockFailWebhookEvent.mockResolvedValue(undefined);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("isRetryableStageFailure", () => {
  it("treats silence as retryable, because no answer is what a second attempt fixes", () => {
    expect(isRetryableStageFailure(undefined)).toBe(true);
  });

  it("treats a 5xx as retryable - the globe is down, restarting or deploying", () => {
    expect(isRetryableStageFailure(500)).toBe(true);
    expect(isRetryableStageFailure(503)).toBe(true);
  });

  it("treats a 4xx as permanent - the next identical request is refused identically", () => {
    expect(isRetryableStageFailure(400)).toBe(false);
    expect(isRetryableStageFailure(404)).toBe(false);
    // Deliberate: the globe does not rate-limit these endpoints, so a 429 is
    // something unexpected rather than backpressure.
    expect(isRetryableStageFailure(429)).toBe(false);
  });
});

describe("shouldAskStripeToRetry", () => {
  const permanent: StageFailure = {
    failure: { stage: "provision", eventId: "evt_1", eventType: "checkout.session.completed", error: "globe 400" },
    retryable: false,
  };
  const retryable: StageFailure = {
    failure: { stage: "tier_sync", eventId: "evt_1", eventType: "checkout.session.completed", error: "globe 503" },
    retryable: true,
  };

  it("is false when nothing was queued", () => {
    expect(shouldAskStripeToRetry([])).toBe(false);
  });

  it("is false when every failure is permanent", () => {
    expect(shouldAskStripeToRetry([permanent])).toBe(false);
  });

  it("is true when any failure could still be fixed by a redelivery", () => {
    expect(shouldAskStripeToRetry([permanent, retryable])).toBe(true);
  });
});

describe("noteTierSyncFailure", () => {
  it("queues nothing when the sync succeeded", () => {
    const queue: StageFailure[] = [];

    noteTierSyncFailure(queue, context, { ok: true, status: 200 });

    expect(queue).toEqual([]);
  });

  it("queues the globe's status and body when the sync failed", () => {
    const queue: StageFailure[] = [];

    noteTierSyncFailure(queue, context, { ok: false, status: 500, detail: "globe exploded" });

    expect(queue).toEqual([
      {
        failure: {
          stage: "tier_sync",
          eventId: "evt_1",
          eventType: "customer.subscription.deleted",
          email: "cancel@example.com",
          userId: "uid_1",
          error: "globe tier sync failed: 500 (globe exploded)",
        },
        retryable: true,
      },
    ]);
  });

  it("names a transport failure as such rather than inventing a status", () => {
    const queue: StageFailure[] = [];

    noteTierSyncFailure(queue, context, { ok: false, detail: "fetch failed" });

    expect(queue[0].failure.error).toBe("globe tier sync failed: transport error (fetch failed)");
    expect(queue[0].retryable).toBe(true);
  });

  it("marks a rejected sync permanent, so Stripe is not asked to repeat it", () => {
    const queue: StageFailure[] = [];

    noteTierSyncFailure(queue, context, { ok: false, status: 400, detail: "Invalid trialsEndAt date" });

    expect(queue[0].retryable).toBe(false);
  });
});

describe("noteProvisionFailure", () => {
  it("asks for a redelivery when the globe 5xxes, so a down globe is not a lost workspace", () => {
    const queue: StageFailure[] = [];

    noteProvisionFailure(queue, context, { status: 503, detail: "unavailable" });

    expect(queue).toEqual([
      {
        failure: {
          stage: "provision",
          eventId: "evt_1",
          eventType: "customer.subscription.deleted",
          email: "cancel@example.com",
          userId: "uid_1",
          error: "globe provisioning failed: 503 (unavailable)",
        },
        retryable: true,
      },
    ]);
  });

  it("asks for a redelivery when the globe never answered", () => {
    const queue: StageFailure[] = [];

    noteProvisionFailure(queue, context, { detail: "fetch failed" });

    expect(queue[0].failure.error).toBe("globe provisioning failed: transport error (fetch failed)");
    expect(queue[0].retryable).toBe(true);
  });

  it("does not ask for a redelivery the globe has already refused", () => {
    const queue: StageFailure[] = [];

    noteProvisionFailure(queue, context, { status: 400, detail: "invalid email" });

    expect(queue[0].retryable).toBe(false);
  });
});

describe("noteMissingHubUserId", () => {
  it("is permanent: no redelivery can add metadata the session was delivered without", () => {
    const queue: StageFailure[] = [];

    noteMissingHubUserId(queue, context, "cs_orphan_123");

    expect(queue).toEqual([
      {
        failure: {
          stage: "provision",
          eventId: "evt_1",
          eventType: "customer.subscription.deleted",
          email: "cancel@example.com",
          userId: "uid_1",
          error:
            "no hubUserId on checkout session cs_orphan_123; nothing was provisioned and no redelivery can add one",
        },
        retryable: false,
      },
    ]);
  });
});

describe("abandonIncompleteDelivery", () => {
  const failures: StageFailure[] = [
    {
      failure: { stage: "provision", eventId: "evt_1", eventType: "checkout.session.completed", error: "globe 500" },
      retryable: true,
    },
    {
      failure: { stage: "tier_sync", eventId: "evt_1", eventType: "checkout.session.completed", error: "globe 500" },
      retryable: true,
    },
  ];

  it("files one durable failure per stage", async () => {
    await abandonIncompleteDelivery("evt_1", "checkout.session.completed", failures);

    expect(mockRecordStageFailure).toHaveBeenCalledTimes(2);
    expect(mockRecordStageFailure).toHaveBeenNthCalledWith(1, failures[0].failure);
    expect(mockRecordStageFailure).toHaveBeenNthCalledWith(2, failures[1].failure);
  });

  it("records the summary on the ledger so the event does not read as handled", async () => {
    await abandonIncompleteDelivery("evt_1", "checkout.session.completed", failures);

    expect(mockFailWebhookEvent).toHaveBeenCalledWith(
      "evt_1",
      "provision: globe 500; tier_sync: globe 500",
    );
  });

  it("says in the log which verdict the delivery was closed out under", async () => {
    await abandonIncompleteDelivery("evt_1", "checkout.session.completed", failures);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("retryable, answering 500"));

    warnSpy.mockClear();
    await abandonIncompleteDelivery("evt_1", "checkout.session.completed", [
      { ...failures[0], retryable: false },
    ]);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("permanent, answering 200"));
  });

  it("keeps going when one failure cannot be recorded, so the others still are", async () => {
    mockRecordStageFailure.mockResolvedValueOnce(false);

    await abandonIncompleteDelivery("evt_1", "checkout.session.completed", failures);

    expect(mockRecordStageFailure).toHaveBeenCalledTimes(2);
    expect(mockFailWebhookEvent).toHaveBeenCalled();
  });
});
