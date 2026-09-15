import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockRecordFailure, mockUpsertSubscriptionFromStripe, mockNotify } = vi.hoisted(() => ({
  mockRecordFailure: vi.fn(),
  mockUpsertSubscriptionFromStripe: vi.fn(),
  mockNotify: vi.fn(),
}));

vi.mock("@/lib/billing/records", () => ({
  recordFailure: mockRecordFailure,
  upsertSubscriptionFromStripe: mockUpsertSubscriptionFromStripe,
}));
vi.mock("@/lib/alerts/notify", () => ({ notify: mockNotify }));

import type { StripeSubscriptionInput } from "@/lib/billing/billing-tables";
import { recordStageFailure, writeSubscriptionRecord } from "@/lib/billing/webhook-record";

const subscription: StripeSubscriptionInput = {
  user_id: "uid_1",
  email: "pay@customer.com",
  stripe_customer_id: "cus_1",
  stripe_subscription_id: "sub_1",
  price_id: "price_pro_monthly",
  interval: "month",
  status: "active",
  source: "stripe",
};

beforeEach(() => {
  mockRecordFailure.mockReset();
  mockUpsertSubscriptionFromStripe.mockReset();
  mockNotify.mockReset();
  mockNotify.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("writeSubscriptionRecord", () => {
  it("alerts critical when the durable subscription record is lost", async () => {
    mockUpsertSubscriptionFromStripe.mockResolvedValue({ ok: false, action: "error", detail: "permission denied" });

    const result = await writeSubscriptionRecord(subscription);

    expect(result.ok).toBe(false);
    expect(mockNotify).toHaveBeenCalledWith(
      "critical",
      "Billing ledger write lost: subscription record",
      expect.stringContaining("permission denied"),
      expect.objectContaining({
        table: "billing_subscriptions",
        action: "error",
        userId: "uid_1",
        customerId: "cus_1",
        subscriptionId: "sub_1",
      }),
    );
  });

  it("alerts critical when the write throws rather than returning", async () => {
    mockUpsertSubscriptionFromStripe.mockRejectedValue(new Error("connection terminated"));

    const result = await writeSubscriptionRecord(subscription);

    expect(result).toEqual({ ok: false, action: "error", detail: "connection terminated" });
    expect(mockNotify).toHaveBeenCalledWith(
      "critical",
      "Billing ledger write lost: subscription record",
      expect.stringContaining("connection terminated"),
      expect.objectContaining({ action: "error" }),
    );
  });

  it("does NOT alert when the automation refused to undo an operator grant, because nothing was lost", async () => {
    mockUpsertSubscriptionFromStripe.mockResolvedValue({ ok: false, action: "manual-protected", detail: "manual row" });

    const result = await writeSubscriptionRecord(subscription);

    // A normal outcome on a system with overrides. Alerting on it is how an
    // operator learns to ignore the critical ones.
    expect(result.ok).toBe(false);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("does not alert on an ignored out-of-order event or a clean write", async () => {
    mockUpsertSubscriptionFromStripe.mockResolvedValue({ ok: true, action: "ignored", detail: "older event" });
    await writeSubscriptionRecord(subscription);

    mockUpsertSubscriptionFromStripe.mockResolvedValue({ ok: true, action: "updated" });
    await writeSubscriptionRecord(subscription);

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("never sends the customer's email, which is the one field that names a real person", async () => {
    mockUpsertSubscriptionFromStripe.mockResolvedValue({ ok: false, action: "error", detail: "permission denied" });

    await writeSubscriptionRecord(subscription);

    expect(JSON.stringify(mockNotify.mock.calls)).not.toContain("pay@customer.com");
  });
});

describe("recordStageFailure", () => {
  it("alerts critical when a stage failure cannot be filed, because the queue is the only trace it would leave", async () => {
    mockRecordFailure.mockResolvedValue(false);

    const recorded = await recordStageFailure({
      stage: "tier_sync",
      eventId: "evt_9",
      eventType: "customer.subscription.updated",
      email: "pay@customer.com",
      userId: "uid_1",
      error: "globe tier sync failed: 503",
    });

    expect(recorded).toBe(false);
    expect(mockNotify).toHaveBeenCalledWith(
      "critical",
      "Billing ledger write lost: tier_sync failure not recorded",
      expect.stringContaining("billing_failures"),
      expect.objectContaining({
        table: "billing_failures",
        stage: "tier_sync",
        eventId: "evt_9",
        eventType: "customer.subscription.updated",
        userId: "uid_1",
      }),
    );
  });

  it("stays quiet when the failure was filed, since the table is already the record of it", async () => {
    mockRecordFailure.mockResolvedValue(true);

    const recorded = await recordStageFailure({ stage: "provision", eventId: "evt_9", error: "globe 400" });

    expect(recorded).toBe(true);
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
