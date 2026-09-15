import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockAdminClient, mockGetUserById } = vi.hoisted(() => ({
  mockAdminClient: vi.fn(),
  mockGetUserById: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mockAdminClient }));

import { resolveVerifiedHubUserId, firstVerifiedHubUserId } from "@/lib/billing/hub-user";

beforeEach(() => {
  mockAdminClient.mockReset();
  mockGetUserById.mockReset();
  mockAdminClient.mockReturnValue({ auth: { admin: { getUserById: mockGetUserById } } });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveVerifiedHubUserId", () => {
  it("returns the id when the candidate is a real hub user", async () => {
    mockGetUserById.mockResolvedValue({ data: { user: { id: "user_abc" } }, error: null });

    expect(await resolveVerifiedHubUserId("user_abc")).toBe("user_abc");
    expect(mockGetUserById).toHaveBeenCalledWith("user_abc");
  });

  it("stores NULL for a marketplace cuid that is not a hub user", async () => {
    // The marketplace writes its own Prisma cuid into the same Stripe account's
    // metadata.userId, so this is a normal input, not a corrupt one.
    mockGetUserById.mockResolvedValue({ data: { user: null }, error: { message: "User not found" } });

    expect(await resolveVerifiedHubUserId("clx8marketplacecuid")).toBeNull();
  });

  it("stores NULL when the lookup reports no user without an error", async () => {
    mockGetUserById.mockResolvedValue({ data: { user: null }, error: null });

    expect(await resolveVerifiedHubUserId("user_missing")).toBeNull();
  });

  it("stores NULL instead of propagating a lookup failure", async () => {
    mockGetUserById.mockRejectedValue(new Error("auth service unreachable"));

    await expect(resolveVerifiedHubUserId("user_abc")).resolves.toBeNull();
  });

  it("stores NULL when the admin client itself is unavailable", async () => {
    mockAdminClient.mockImplementation(() => {
      throw new Error("missing SUPABASE_SERVICE_ROLE_KEY");
    });

    expect(await resolveVerifiedHubUserId("user_abc")).toBeNull();
  });

  it.each([null, undefined, ""])("stores NULL for %s without calling Stripe or Supabase", async (candidate) => {
    expect(await resolveVerifiedHubUserId(candidate)).toBeNull();
    expect(mockGetUserById).not.toHaveBeenCalled();
  });
});

describe("firstVerifiedHubUserId", () => {
  it("skips an unusable candidate and returns the first one that verifies", async () => {
    mockGetUserById
      .mockResolvedValueOnce({ data: { user: null }, error: { message: "User not found" } })
      .mockResolvedValueOnce({ data: { user: { id: "user_hub" } }, error: null });

    expect(await firstVerifiedHubUserId(["clxcuid", "user_hub"])).toBe("user_hub");
  });

  it("returns NULL when no candidate verifies", async () => {
    mockGetUserById.mockResolvedValue({ data: { user: null }, error: { message: "User not found" } });

    expect(await firstVerifiedHubUserId(["clxcuid", null, undefined])).toBeNull();
  });

  it("never calls Supabase when every candidate is empty", async () => {
    expect(await firstVerifiedHubUserId([null, undefined, ""])).toBeNull();
    expect(mockGetUserById).not.toHaveBeenCalled();
  });
});
