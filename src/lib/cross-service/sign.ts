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

export function signCrossServiceRequest(opts: {
    method: string;
    path: string;
    body?: unknown;
    timestamp?: number;
}): SignedHeaders {
    const secret = getSecret();
    const nonce = crypto.randomUUID();
    const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);

    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : "";
    const bodyHash = sha256Hex(bodyStr);
    const canon = `${opts.method}\n${opts.path}\n${timestamp}\n${bodyHash}`;

    const sig = crypto.createHmac("sha256", secret).update(canon, "utf8").digest("hex");

    return {
        "X-Service-Signature": `t=${timestamp},n=${nonce},sig=${sig}`,
        "X-Service-Timestamp": String(timestamp),
        "X-Service-Nonce": nonce,
    };
}
