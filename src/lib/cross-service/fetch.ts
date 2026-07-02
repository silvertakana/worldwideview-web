import { signCrossServiceRequest } from "./sign";

export async function crossServiceFetch(
    path: string,
    opts: { method?: string; body?: unknown; searchParams?: Record<string, string>; headers?: Record<string, string> } = {},
): Promise<Response> {
    const baseUrl = process.env.PROVISIONING_API_URL || "https://wwv.local:3443";

    let url = `${baseUrl}${path}`;
    if (opts.searchParams) {
        const params = new URLSearchParams(opts.searchParams);
        url += `?${params.toString()}`;
    }

    const method = opts.method ?? "GET";

    const signedHeaders = signCrossServiceRequest({
        method,
        path,
        body: opts.body,
    });

    const fetchOpts: RequestInit & { headers: Record<string, string> } = {
        method,
        headers: {
            "Content-Type": "application/json",
            ...signedHeaders,
            ...opts.headers,
        },
    };

    if (opts.body !== undefined) {
        fetchOpts.body = JSON.stringify(opts.body);
    }

    return fetch(url, fetchOpts);
}
