import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";

// hub-user.ts validates every candidate uid through the admin client, and the
// REAL hub-user.ts runs here (it is the "validated or NULL" rule under test).
const { mockRetrieveCustomer, mockAdminClient, mockGetUserById } = vi.hoisted(() => ({
  mockRetrieveCustomer: vi.fn(),
  mockAdminClient: vi.fn(),
  mockGetUserById: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mockAdminClient }));

import {
  UnresolvedIdentityError,
  emailFromPayload,
  resolveIdentity,
  type PayloadEmailFields,
} from "@/lib/billing/webhook-identity";

const stripe = { customers: { retrieve: mockRetrieveCustomer } } as unknown as Stripe;

beforeEach(() => {
  mockRetrieveCustomer.mockReset();
  mockGetUserById.mockReset();
  mockAdminClient.mockReset();
  mockGetUserById.mockImplementation((uid: string) =>
    Promise.resolve(
      uid === "uid_hub"
        ? { data: { user: { id: "uid_hub" } }, error: null }
        : { data: { user: null }, error: { message: "User not found" } },
    ),
  );
  mockAdminClient.mockReturnValue({ auth: { admin: { getUserById: mockGetUserById } } });
});

/** The thrown gap, or a failure if the call did not throw at all. */
async function gapFrom(payload: PayloadEmailFields, candidates: Array<string | null | undefined> = []) {
  try {
    await resolveIdentity(stripe, payload, candidates);
  } catch (err) {
    if (err instanceof UnresolvedIdentityError) return { kind: err.kind, message: err.message };
    throw err;
  }
  throw new Error("expected resolveIdentity to throw");
}

describe("emailFromPayload", () => {
  it("prefers customer_email over every other field", () => {
    expect(
      emailFromPayload({
        customer_email: "top@example.com",
        customer_details: { email: "details@example.com" },
        customer: { email: "object@example.com" },
        metadata: { email: "meta@example.com" },
      }),
    ).toBe("top@example.com");
  });

  it("falls back to customer_details.email, then an expanded customer object", () => {
    expect(emailFromPayload({ customer_details: { email: "details@example.com" } })).toBe("details@example.com");
    expect(emailFromPayload({ customer: { email: "object@example.com" } })).toBe("object@example.com");
  });

  it("returns null for a bare customer id, which carries no email", () => {
    expect(emailFromPayload({ customer: "cus_abc" })).toBeNull();
    expect(emailFromPayload({})).toBeNull();
  });
});

describe("resolveIdentity", () => {
  it("uses a payload email and never calls Stripe", async () => {
    const identity = await resolveIdentity(stripe, { customer_email: "pay@example.com" }, ["uid_hub"]);

    expect(identity.email).toBe("pay@example.com");
    expect(identity.userId).toBe("uid_hub");
    expect(mockRetrieveCustomer).not.toHaveBeenCalled();
  });

  it("accepts metadata.email as the hub-specific fallback, still without calling Stripe", async () => {
    const identity = await resolveIdentity(stripe, { metadata: { email: "meta@example.com" } }, []);

    expect(identity.email).toBe("meta@example.com");
    expect(mockRetrieveCustomer).not.toHaveBeenCalled();
  });

  it("retrieves the customer when the payload carries no email, taking the email and the uid candidate off that one object", async () => {
    mockRetrieveCustomer.mockResolvedValue({
      id: "cus_abc",
      deleted: false,
      email: "outbound@example.com",
      metadata: { userId: "uid_hub" },
    });

    const identity = await resolveIdentity(stripe, { customer: "cus_abc" }, [undefined]);

    expect(mockRetrieveCustomer).toHaveBeenCalledWith("cus_abc");
    expect(identity.email).toBe("outbound@example.com");
    expect(identity.userId).toBe("uid_hub");
  });

  it("stores NULL rather than a candidate uid that resolves to no user", async () => {
    mockRetrieveCustomer.mockResolvedValue({
      id: "cus_abc",
      deleted: false,
      email: "outbound@example.com",
      // The marketplace writes its own Prisma cuid into the same Stripe account's
      // metadata.userId, so an unvalidated value can point at nobody here.
      metadata: { userId: "cm_marketplace_cuid" },
    });

    const identity = await resolveIdentity(stripe, { customer: "cus_abc" }, []);

    expect(identity.userId).toBeNull();
    expect(mockGetUserById).toHaveBeenCalledWith("cm_marketplace_cuid");
  });

  it("reports a deleted customer as 'absent', not as a transient failure", async () => {
    mockRetrieveCustomer.mockResolvedValue({ id: "cus_abc", deleted: true });

    const gap = await gapFrom({ customer: "cus_abc" });

    expect(gap.kind).toBe("absent");
    expect(gap.message).toContain("no usable customer email");
    expect(gap.message).toContain("cus_abc");
  });

  it("reports a customer that simply has no email as 'absent'", async () => {
    mockRetrieveCustomer.mockResolvedValue({ id: "cus_abc", deleted: false, email: null });

    expect((await gapFrom({ customer: "cus_abc" })).kind).toBe("absent");
  });

  it("reports an event with no email and no customer to look one up on as 'absent', without calling Stripe", async () => {
    const gap = await gapFrom({});

    expect(gap.kind).toBe("absent");
    expect(mockRetrieveCustomer).not.toHaveBeenCalled();
  });

  it("reports a failed retrieve as 'unavailable', so the caller can ask Stripe to retry", async () => {
    mockRetrieveCustomer.mockRejectedValue(new Error("429 Too Many Requests"));

    const gap = await gapFrom({ customer: "cus_abc" });

    expect(gap.kind).toBe("unavailable");
    expect(gap.message).toContain("could not retrieve Stripe customer cus_abc");
    expect(gap.message).toContain("429");
  });

  it("keeps the two gaps distinguishable by their message, since both fail the same way", async () => {
    mockRetrieveCustomer.mockResolvedValueOnce({ id: "cus_abc", deleted: true });
    const absent = await gapFrom({ customer: "cus_abc" });

    mockRetrieveCustomer.mockRejectedValueOnce(new Error("503 Service Unavailable"));
    const unavailable = await gapFrom({ customer: "cus_abc" });

    expect(absent.message).not.toBe(unavailable.message);
    expect(absent.message).toContain("no usable customer email");
    expect(unavailable.message).toContain("could not retrieve");
  });
});
