"use client";

import { useState } from "react";
import { Zap, ExternalLink } from "lucide-react";
import hubStyles from "../../hub/hub.module.css";

export function ManageBillingClient({ plan, status }: { plan: string; status: string }) {
    const [loading, setLoading] = useState(false);
    const isLocal = plan === "local";
    const isSuspended = status === "suspended";
    const isDeleted = status === "deleted";

    async function handleUpgrade() {
        setLoading(true);
        try {
            const res = await fetch("/api/billing/checkout", {
                method: "POST",
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
            const res = await fetch("/api/billing/portal", {
                method: "POST",
            });
            const data = await res.json();
            if (data.url) window.location.href = data.url;
        } catch {
            setLoading(false);
        }
    }

    if (isDeleted) {
        return (
            <p style={{ color: "var(--color-danger, #ef4444)", fontSize: "0.9rem" }}>
                Your account has been closed.
            </p>
        );
    }

    if (isLocal) {
        return (
            <button onClick={handleUpgrade} disabled={loading} className={hubStyles.submitButton}>
                <Zap size={16} style={{ marginRight: "var(--space-xs)" }} />
                {loading ? "Loading..." : "Upgrade to Pro"}
            </button>
        );
    }

    return (
        <button
            onClick={isSuspended ? handleManageBilling : handleManageBilling}
            disabled={loading}
            className={hubStyles.submitButton}
            style={isSuspended ? {
                background: "transparent",
                color: "var(--color-danger, #ef4444)",
                border: "1px solid var(--color-danger, #ef4444)",
            } : {}}
        >
            <ExternalLink size={16} style={{ marginRight: "var(--space-xs)" }} />
            {loading
                ? "Loading..."
                : isSuspended
                    ? "Update Payment Method"
                    : "Manage Billing"}
        </button>
    );
}
