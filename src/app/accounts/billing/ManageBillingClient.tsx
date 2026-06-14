"use client";

import { useState } from "react";
import { Zap, ExternalLink } from "lucide-react";
import hubStyles from "../../hub/hub.module.css";

const MARKETPLACE_URL = process.env.NEXT_PUBLIC_MARKETPLACE_URL ?? "https://marketplace.worldwideview.dev";

export function ManageBillingClient({ isFree }: { isFree: boolean }) {
    const [loading, setLoading] = useState(false);

    async function handleUpgrade() {
        setLoading(true);
        try {
            const res = await fetch(`${MARKETPLACE_URL}/api/billing/checkout`, {
                method: "POST",
                credentials: "include",
            });
            const data = await res.json();
            if (data.url) window.location.href = data.url;
        } catch {
            setLoading(false);
        }
    }

    async function handleManageBilling() {
        setLoading(true);
        try {
            const res = await fetch(`${MARKETPLACE_URL}/api/billing/portal`, {
                method: "POST",
                credentials: "include",
            });
            const data = await res.json();
            if (data.url) window.location.href = data.url;
        } catch {
            setLoading(false);
        }
    }

    if (isFree) {
        return (
            <button onClick={handleUpgrade} disabled={loading} className={hubStyles.submitButton}>
                <Zap size={16} style={{ marginRight: "var(--space-xs)" }} />
                {loading ? "Loading..." : "Upgrade to Pro"}
            </button>
        );
    }

    return (
        <button onClick={handleManageBilling} disabled={loading} className={hubStyles.submitButton}>
            <ExternalLink size={16} style={{ marginRight: "var(--space-xs)" }} />
            {loading ? "Loading..." : "Manage Billing"}
        </button>
    );
}
