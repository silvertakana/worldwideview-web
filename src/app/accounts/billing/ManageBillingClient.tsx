"use client";

import { useState } from "react";
import { Zap, ExternalLink } from "lucide-react";
import { BILLING_ENABLED } from "@/lib/billing/constants";
import hubStyles from "../../hub/hub.module.css";

export function ManageBillingClient({ plan, status, paused }: { plan: string; status: string; paused: boolean }) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const isLocal = plan === "local";

    if (!BILLING_ENABLED) {
        return (
            <p style={{ color: "var(--color-text-muted)", fontSize: "0.9rem" }}>
                Billing is not available during the beta period.
            </p>
        );
    }
    const isSuspended = status === "suspended";
    const isDeleted = status === "deleted";

    async function handleUpgrade() {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch("/api/billing/checkout", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ plan: "pro" }),
            });
            const data = await res.json();
            if (!res.ok) {
                // A paused checkout answers 503 with the generic copy plus an
                // operator-supplied `reason` (absent for an "unavailable"
                // kill-switch state, which must not leak internal text).
                const reason = typeof data.reason === "string" && data.reason ? ` (${data.reason})` : "";
                setError(`${data.error || "Failed to start checkout"}${reason}`);
                setLoading(false);
                return;
            }
            if (data.url) window.location.href = data.url;
        } catch {
            setLoading(false);
        }
    }

    async function handleManageBilling() {
        // Deliberately NOT gated by the runtime kill switch: the customer portal
        // must always work so a subscriber can cancel or update their card.
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
        if (paused) {
            return (
                <span
                    aria-disabled="true"
                    style={{
                        display: "inline-flex", alignItems: "center", gap: "var(--space-xs)",
                        color: "var(--color-text-muted)", fontSize: "0.9rem", cursor: "default",
                    }}
                >
                    <Zap size={16} />
                    Temporarily unavailable
                </span>
            );
        }
        return (
            <>
                {error && (
                    <p style={{ color: "var(--color-danger, #ef4444)", fontSize: "0.85rem", marginBottom: "var(--space-xs)" }}>
                        {error}
                    </p>
                )}
                <button onClick={handleUpgrade} disabled={loading} className={hubStyles.submitButton}>
                    <Zap size={16} style={{ marginRight: "var(--space-xs)" }} />
                    {loading ? "Loading..." : "Upgrade to Pro"}
                </button>
            </>
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
