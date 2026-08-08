import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";

// ── Hoisted env ───────────────────────────────────────────────────
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_WORKSPACE_DOMAIN = "cloud-wwv.dev";
});

// ── Mock browser globals ──────────────────────────────────────────
const mockFetch = vi.fn();

vi.stubGlobal("fetch", mockFetch);

// ── Helpers ───────────────────────────────────────────────────────

const WS = { id: "ws_abc", name: "My Instance", subdomain: "myinst", status: "active" };

const ACCOUNT = {
  tier: "pro",
  plan: "pro",
  status: "active",
  trialEndsAt: null,
  instanceCount: 1,
  instanceLimit: 10,
  isTrialing: false,
  trialDaysRemaining: null,
};

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

// These are the calls the component makes on mount:
// 1. GET /api/provisioning/workspace + GET /api/auth/entitlement  (parallel)
// 2. GET /api/provisioning/workspace/{id}/status  (per workspace)
const MOUNT_FETCHES = {
  workspace: () => json({ workspaces: [WS], account: ACCOUNT }),
  entitlement: () => json({ orgId: "org_1", hasEntitlement: true, entitlementUsed: false }),
  status: () => json({ setupCompleted: true }),
};

const LOADING_TEXT = "Loading workspaces...";

// ── Setup ─────────────────────────────────────────────────────────

beforeEach(() => {
  mockFetch.mockReset();

  // Default: return successful responses for mount
  mockFetch.mockImplementation((url: string) => {
    if (url === "/api/provisioning/workspace") return MOUNT_FETCHES.workspace();
    if (url === "/api/auth/entitlement") return MOUNT_FETCHES.entitlement();
    if (url.includes("/status")) return MOUNT_FETCHES.status();
    return Promise.reject(new Error(`Unmocked fetch: ${url}`));
  });

  // Suppress React act() warnings from async state updates
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helper: render and wait until loaded ──────────────────────────

async function renderLoaded() {
  const mod = await import("./page");
  const result = render(<mod.default />);

  // Wait for loading text to disappear
  await waitFor(() => {
    expect(screen.queryByText(LOADING_TEXT)).toBeNull();
  });

  return result;
}

// ── Tests ─────────────────────────────────────────────────────────

describe("InstancesPage — delete race condition", () => {
  it("shows the delete confirmation modal when the trash button is clicked", async () => {
    await renderLoaded();

    // Find the delete button (has data-tooltip="Delete")
    const deleteBtn = document.querySelector('[data-tooltip="Delete"]') as HTMLButtonElement;
    expect(deleteBtn).not.toBeNull();

    await act(async () => {
      fireEvent.click(deleteBtn);
    });

    // Modal should show the workspace name and delete text.
    // "My Instance" appears both in the workspace list AND the modal title.
    const matches = screen.getAllByText(/My Instance/);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/permanently delete/)).toBeInTheDocument();
  });

  it("resets the delete button and shows an error when the DELETE fetch rejects", async () => {
    await renderLoaded();

    // Open the delete modal
    const deleteBtn = document.querySelector('[data-tooltip="Delete"]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(deleteBtn);
    });

    // Verify modal is open
    expect(screen.getByText(/permanently delete/)).toBeInTheDocument();

    // Now override the fetch mock for the DELETE call to reject
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return Promise.reject(new Error("Connection refused"));
      if (url === "/api/provisioning/workspace") return MOUNT_FETCHES.workspace();
      if (url === "/api/auth/entitlement") return MOUNT_FETCHES.entitlement();
      if (url.includes("/status")) return MOUNT_FETCHES.status();
      return Promise.reject(new Error(`Unmocked fetch: ${url}`));
    });

    // Click the "Delete" confirm button inside the modal
    const confirmBtn = screen.getByRole("button", { name: "Delete" });

    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // After rejection + finally, the button should reset (not stuck on "Deleting...")
    await waitFor(() => {
      const btns = screen.getAllByRole("button", { name: "Delete" });
      const enabled = btns.find((b) => !(b as HTMLButtonElement).disabled);
      expect(enabled).toBeDefined();
    });

    // The error message should appear
    expect(
      screen.getByText("Failed to delete instance. Please try again."),
    ).toBeInTheDocument();
  });

  it("shows 'Deleting...' while the DELETE request is in-flight", async () => {
    await renderLoaded();

    // Open the delete modal
    const deleteBtn = document.querySelector('[data-tooltip="Delete"]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(deleteBtn);
    });

    // Set up a never-resolving promise so we can observe the "Deleting..." state
    let resolveDelete: (value: Response) => void;
    const deletePromise = new Promise<Response>((resolve) => {
      resolveDelete = resolve;
    });

    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return deletePromise;
      if (url === "/api/provisioning/workspace") return MOUNT_FETCHES.workspace();
      if (url === "/api/auth/entitlement") return MOUNT_FETCHES.entitlement();
      if (url.includes("/status")) return MOUNT_FETCHES.status();
      return Promise.reject(new Error(`Unmocked fetch: ${url}`));
    });

    // Click the confirm button
    const confirmBtn = screen.getByRole("button", { name: "Delete" });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // While pending, the button should show "Deleting..."
    await waitFor(() => {
      expect(screen.getByText("Deleting...")).toBeInTheDocument();
    });

    // The Cancel button should be disabled while deleting
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    expect(cancelBtn).toBeDisabled();

    // Resolve the promise to clean up (inside act since it triggers state update)
    await act(async () => {
      resolveDelete!(new Response(JSON.stringify({ deleted: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
      // Let the microtasks flush
      await new Promise((r) => setTimeout(r, 0));
    });
  });
});
