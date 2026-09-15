import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRecordStageFailure, mockFailWebhookEvent } = vi.hoisted(() => ({
  mockRecordStageFailure: vi.fn(),
  mockFailWebhookEvent: vi.fn(),
}));

vi.mock("@/lib/billing/webhook-record", () => ({ recordStageFailure: mockRecordStageFailure }));
vi.mock("@/lib/billing/webhook-idempotency", () => ({ failWebhookEvent: mockFailWebhookEvent }));

import {
  abandonIncompleteDelivery,
  noteTierSyncFailure,
  type StageFailureContext,
} from "@/lib/billing/webhook-stages";
import type { BillingFailureInput } from "@/lib/billing/billing-tables";

const context: StageFailureContext = {
  eventId: "evt_1",
  eventType: "customer.subscription.deleted",
  email: "cancel@example.com",
  userId: "uid_1",
};

beforeEach(() => {
  mockRecordStageFailure.mockReset();
  mockFailWebhookEvent.mockReset();
  mockRecordStageFailure.mockResolvedValue(true);
  mockFailWebhookEvent.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("noteTierSyncFailure", () => {
  it("queues nothing when the sync succeeded", () => {
    const queue: BillingFailureInput[] = [];

    noteTierSyncFailure(queue, context, { ok: true, status: 200 });

    expect(queue).toEqual([]);
  });

  it("queues the globe's status and body when the sync failed", () => {
    const queue: BillingFailureInput[] = [];

    noteTierSyncFailure(queue, context, { ok: false, status: 500, detail: "globe exploded" });

    expect(queue).toEqual([
      {
        stage: "tier_sync",
        eventId: "evt_1",
        eventType: "customer.subscription.deleted",
        email: "cancel@example.com",
        userId: "uid_1",
        error: "globe tier sync failed: 500 (globe exploded)",
      },
    ]);
  });

  it("names a transport failure as such rather than inventing a status", () => {
    const queue: BillingFailureInput[] = [];

    noteTierSyncFailure(queue, context, { ok: false, detail: "fetch failed" });

    expect(queue[0].error).toBe("globe tier sync failed: transport error (fetch failed)");
  });
});

describe("abandonIncompleteDelivery", () => {
  const failures: BillingFailureInput[] = [
    { stage: "provision", eventId: "evt_1", eventType: "checkout.session.completed", error: "globe 500" },
    { stage: "tier_sync", eventId: "evt_1", eventType: "checkout.session.completed", error: "globe 500" },
  ];

  it("files one durable failure per stage", async () => {
    await abandonIncompleteDelivery("evt_1", "checkout.session.completed", failures);

    expect(mockRecordStageFailure).toHaveBeenCalledTimes(2);
    expect(mockRecordStageFailure).toHaveBeenNthCalledWith(1, failures[0]);
    expect(mockRecordStageFailure).toHaveBeenNthCalledWith(2, failures[1]);
  });

  it("records the summary on the ledger so the event does not read as handled", async () => {
    await abandonIncompleteDelivery("evt_1", "checkout.session.completed", failures);

    expect(mockFailWebhookEvent).toHaveBeenCalledWith(
      "evt_1",
      "provision: globe 500; tier_sync: globe 500",
    );
  });

  it("keeps going when one failure cannot be recorded, so the others still are", async () => {
    mockRecordStageFailure.mockResolvedValueOnce(false);

    await abandonIncompleteDelivery("evt_1", "checkout.session.completed", failures);

    expect(mockRecordStageFailure).toHaveBeenCalledTimes(2);
    expect(mockFailWebhookEvent).toHaveBeenCalled();
  });
});
