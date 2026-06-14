import { CreditCard, Zap } from "lucide-react";
import styles from "../accounts.module.css";
import { ManageBillingClient } from "./ManageBillingClient";

const MARKETPLACE_URL = process.env.NEXT_PUBLIC_MARKETPLACE_URL ?? "https://marketplace.wwv.local:3004";
const MARKETPLACE_SECRET = process.env.MARKETPLACE_INTERNAL_SECRET ?? "";

export const metadata = { title: "Billing | Your Account" };

async function getSubscription(userId: string) {
    try {
        const res = await fetch(`${MARKETPLACE_URL}/api/internal/billing/subscription`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-internal-secret": MARKETPLACE_SECRET,
            },
            body: JSON.stringify({ userId }),
            cache: "no-store",
        });
        if (!res.ok) return null;
        return await res.json() as {
            tier: string; effectiveTier: string;
            hasSubscription: boolean; stripeCurrentPeriodEnd: string | null;
        };
    } catch {
        return null;
    }
}

export default async function BillingPage() {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    const sub = user ? await getSubscription(user.id) : null;
    const isFree = !sub || sub.effectiveTier === "free";

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
                    background: isFree ? "var(--color-bg-elevated)" : "var(--color-accent-glow)",
                    color: isFree ? "var(--color-text-muted)" : "var(--color-accent)",
                    border: "1px solid var(--color-border)",
                }}>
                    <Zap size={14} />
                    {isFree ? "Free" : "Pro"}
                </span>
            </div>

            <p style={{ marginBottom: "var(--space-lg)", color: "var(--color-text-secondary)" }}>
                {isFree ? "You are on the Free plan." : "You are on the Pro plan."}
            </p>

            {sub?.stripeCurrentPeriodEnd && (
                <p style={{
                    fontSize: "0.85rem", marginBottom: "var(--space-lg)", color: "var(--color-text-muted)",
                }}>
                    Renews {new Intl.DateTimeFormat("en-US", { dateStyle: "long" })
                        .format(new Date(sub.stripeCurrentPeriodEnd))}
                </p>
            )}

            <ManageBillingClient isFree={isFree} />
        </div>
    );
}
