import { CreditCard, Zap } from "lucide-react";
import styles from "../accounts.module.css";
import { ManageBillingClient } from "./ManageBillingClient";
import { crossServiceFetch } from "@/lib/cross-service/fetch";

export const metadata = { title: "Billing | Your Account" };

export default async function BillingPage() {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    let plan = "local";
    let status = "not_found";
    let trialEndsAt: string | null = null;
    let instanceCount = 0;
    let instanceLimit = Infinity;
    let isTrialing = false;
    let trialDaysRemaining: number | null = null;

    if (user) {
        try {
            const res = await crossServiceFetch(`/api/service/tier?email=${encodeURIComponent(user.email!)}`);
            if (res.ok) {
                const data = await res.json();
                plan = data.plan || "local";
                status = data.status || "not_found";
                trialEndsAt = data.trialEndsAt || null;
                instanceCount = data.instanceCount ?? 0;
                instanceLimit = data.instanceLimit ?? Infinity;
                isTrialing = data.isTrialing ?? (status === "trialing");
                trialDaysRemaining = data.trialDaysRemaining ?? null;
            }
        } catch {
            // Globe unreachable - fall back to local plan
        }
    }

    const isLocal = plan === "local";

    return (
        <div className={styles.pageContent}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)", marginBottom: "var(--space-xl)" }}>
                <CreditCard size={22} />
                <h2 style={{ margin: 0, fontSize: "1.4rem", fontWeight: 600 }}>Subscription</h2>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)", marginBottom: "var(--space-md)" }}>
                <span style={{
                    display: "inline-flex", alignItems: "center", gap: "4px",
                    padding: "4px 14px", borderRadius: "var(--radius-full)",
                    fontSize: "0.85rem", fontWeight: 600,
                    background: isLocal ? "var(--color-bg-elevated)" : "var(--color-accent-glow)",
                    color: isLocal ? "var(--color-text-muted)" : "var(--color-accent)",
                    border: "1px solid var(--color-border)",
                }}>
                    <Zap size={14} />
                    {isLocal ? "Local" : status === "trialing" ? "Pro - Trial" : plan === "enterprise" ? "Enterprise" : "Pro"}
                </span>
                {!isLocal && status !== "active" && (
                    <span style={{
                        display: "inline-flex", alignItems: "center", gap: "4px",
                        padding: "4px 14px", borderRadius: "var(--radius-full)",
                        fontSize: "0.75rem", fontWeight: 600, textTransform: "uppercase",
                        background: status === "trialing" ? "var(--color-warning-bg, #fef9c3)" : "var(--color-danger-bg, #fef2f2)",
                        color: status === "trialing" ? "var(--color-warning, #d97706)" : "var(--color-danger, #dc2626)",
                    }}>
                        {status}
                    </span>
                )}
            </div>

            <p style={{ marginBottom: "var(--space-lg)", color: "var(--color-text-secondary)" }}>
                {isLocal
                    ? "You are on the Free plan."
                    : status === "trialing"
                        ? `You are on the Pro plan (trial).`
                        : status === "suspended"
                            ? "Your account has been suspended."
                            : `You are on the ${plan === "enterprise" ? "Enterprise" : "Pro"} plan.`
                }
            </p>

            {isTrialing && trialDaysRemaining !== null && (
                <p style={{
                    fontSize: "0.85rem", marginBottom: "var(--space-lg)",
                    color: trialDaysRemaining <= 0 ? "var(--color-danger, #ef4444)" : "var(--color-warning, #d97706)",
                }}>
                    {trialDaysRemaining <= 0
                        ? "Your trial has ended. Subscribe to continue using Pro features."
                        : `Your trial ends in ${trialDaysRemaining} day${trialDaysRemaining === 1 ? "" : "s"}.`
                    }
                </p>
            )}

            {!isLocal && (
                <p style={{
                    fontSize: "0.85rem", marginBottom: "var(--space-lg)", color: "var(--color-text-muted)",
                }}>
                    Instances: {instanceCount} of {instanceLimit === Infinity ? "Unlimited" : instanceLimit} used
                </p>
            )}

            <ManageBillingClient
                plan={plan}
                status={status}
            />

            <hr style={{
                margin: "var(--space-xl) 0",
                border: "none",
                borderTop: "1px solid var(--color-border)",
            }} />

            <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                color: "var(--color-text-muted)", fontSize: "0.9rem",
            }}>
                <span>Need more? Contact Us</span>
                <a href="mailto:sales@worldwideview.dev"
                    style={{
                        color: "var(--color-accent)", textDecoration: "none",
                        fontWeight: 500,
                    }}>
                    Contact Us
                </a>
            </div>
        </div>
    );
}
