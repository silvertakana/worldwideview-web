import crypto from "node:crypto";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { signCrossServiceRequest } from "./sign";
import { crossServiceFetch } from "./fetch";

const TEST_SECRET = "test-secret-for-hmac-vitest-2026";

beforeAll(() => {
    process.env.CROSS_SERVICE_SECRET = TEST_SECRET;
});

describe("signCrossServiceRequest", () => {
    it("returns X-Service-Signature header with correct format", () => {
        const headers = signCrossServiceRequest({
            method: "POST",
            path: "/api/instance",
            body: { subdomain: "test" },
        });
        const sig = headers["X-Service-Signature"];
        expect(sig).toMatch(/^t=\d+,n=[0-9a-f-]+,sig=[0-9a-f]+$/);
    });

    it("produces same HMAC as globe-side sign for identical inputs", () => {
        const opts = {
            method: "POST",
            path: "/api/test",
            body: { key: "value" },
            timestamp: 1234567890000,
        };
        const headers = signCrossServiceRequest(opts);
        const sig = headers["X-Service-Signature"].match(/sig=([0-9a-f]+)/)![1];

        const bodyStr = JSON.stringify(opts.body);
        const bodyHash = crypto.createHash("sha256").update(bodyStr, "utf8").digest("hex");
        const canon = `${opts.method}\n${opts.path}\n${opts.timestamp}\n${bodyHash}`;
        const expectedSig = crypto.createHmac("sha256", TEST_SECRET).update(canon, "utf8").digest("hex");

        expect(sig).toBe(expectedSig);
    });
});

describe("crossServiceFetch", () => {
    beforeAll(() => {
        process.env.PROVISIONING_API_URL = "https://globe.test:3443";
    });

    it("adds all three HMAC headers and Content-Type", async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
        vi.stubGlobal("fetch", mockFetch);

        await crossServiceFetch("/api/instance", {
            method: "POST",
            body: { subdomain: "test" },
        });

        const call = mockFetch.mock.calls[0];
        const [url, opts] = call;

        expect(url).toBe("https://globe.test:3443/api/instance");

        expect(opts.headers["X-Service-Signature"]).toBeDefined();
        expect(opts.headers["X-Service-Timestamp"]).toBeDefined();
        expect(opts.headers["X-Service-Nonce"]).toBeDefined();
        expect(opts.headers["Content-Type"]).toBe("application/json");
        expect(opts.headers["x-api-key"]).toBeUndefined();
        expect(opts.method).toBe("POST");
    });

    it("includes searchParams in the URL", async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
        vi.stubGlobal("fetch", mockFetch);

        await crossServiceFetch("/api/account", {
            searchParams: { userId: "abc", email: "test@test.com" },
        });

        const [url] = mockFetch.mock.calls[0];
        expect(url).toContain("userId=abc");
        expect(url).toContain("email=test%40test.com");
    });

    it("throws if CROSS_SERVICE_SECRET is not set", async () => {
        const orig = process.env.CROSS_SERVICE_SECRET;
        delete process.env.CROSS_SERVICE_SECRET;
        process.env.PROVISIONING_API_URL = "https://globe.test:3443";

        await expect(crossServiceFetch("/api/test")).rejects.toThrow(
            "CROSS_SERVICE_SECRET is required",
        );

        process.env.CROSS_SERVICE_SECRET = orig;
    });

    it("returns raw Response for GET with no body", async () => {
        const mockResponse = new Response(JSON.stringify({ instances: [] }), { status: 200 });
        const mockFetch = vi.fn().mockResolvedValue(mockResponse);
        vi.stubGlobal("fetch", mockFetch);

        const res = await crossServiceFetch("/api/instance", {
            searchParams: { userId: "user1" },
        });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toEqual({ instances: [] });
    });

    it("passes extra headers through", async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
        vi.stubGlobal("fetch", mockFetch);

        await crossServiceFetch("/api/instance/foo", {
            method: "DELETE",
            headers: { "x-user-id": "user-123" },
        });

        const [, opts] = mockFetch.mock.calls[0];
        expect(opts.headers["x-user-id"]).toBe("user-123");
        expect(opts.headers["X-Service-Signature"]).toBeDefined();
    });
});
