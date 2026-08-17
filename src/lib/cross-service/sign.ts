import crypto from "node:crypto";

export interface SignedHeaders {
    "X-Service-Signature": string;
    "X-Service-Timestamp": string;
    "X-Service-Nonce": string;
}

function getSecret(): string {
    const secret = process.env.CROSS_SERVICE_SECRET;
    if (!secret) {
        throw new Error("CROSS_SERVICE_SECRET is required for cross-service requests");
    }
    return secret;
}

function sha256Hex(input: string): string {
    return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

// The globe verifier (verify.ts) expects SECONDS since the Unix epoch
// (`Math.floor(Date.now() / 1000)` with a ±300s window). A milliseconds value
// (13-digit, e.g. raw `Date.now()`) would always be rejected as "expired".
// Any timestamp far outside the verification window is unambiguously
// milliseconds (epoch ms is ~1e12 vs ~1.8e9 seconds) — normalize it down to
// seconds. Values inside the window pass through untouched.
function normalizeTimestamp(input: number): number {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return input > nowSeconds + 300 ? Math.floor(input / 1000) : input;
}

export function signCrossServiceRequest(opts: {
    method: string;
    path: string;
    body?: unknown;
    timestamp?: number;
}): SignedHeaders {
    const secret = getSecret();
    const nonce = crypto.randomUUID();
    const timestamp = normalizeTimestamp(opts.timestamp ?? Math.floor(Date.now() / 1000));

    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : "";
    const bodyHash = sha256Hex(bodyStr);
    // The globe verifier builds its canonical string from
    // `new URL(request.url).pathname` (no query string). Sign the same shape so
    // paths like "/api/service/tier?email=..." verify instead of returning 401.
    const signedPath = opts.path.split("?")[0];
    const canon = `${opts.method}\n${signedPath}\n${timestamp}\n${bodyHash}`;

    const sig = crypto.createHmac("sha256", secret).update(canon, "utf8").digest("hex");

    return {
        "X-Service-Signature": `t=${timestamp},n=${nonce},sig=${sig}`,
        "X-Service-Timestamp": String(timestamp),
        "X-Service-Nonce": nonce,
    };
}
