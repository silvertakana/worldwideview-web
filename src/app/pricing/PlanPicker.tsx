"use client";

import { useState, useCallback } from "react";
import { Check } from "lucide-react";
import type { PricingPlan } from "@/app/api/pricing/route";
import styles from "./page.module.css";

function formatPrice(cents: number): string {
  return (cents / 100).toFixed(0);
}

function formatInterval(interval: "month" | "year"): string {
  return interval === "month" ? "mo" : "yr";
}

interface PlanPickerProps {
  plans: PricingPlan[];
  userId: string | null;
  userEmail?: string;
  hasSubscription: boolean;
}

export default function PlanPicker({ plans, userId, userEmail, hasSubscription }: PlanPickerProps) {
  const [selectedInterval, setSelectedInterval] = useState<"month" | "year">("month");
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [subscribeError, setSubscribeError] = useState<string | null>(null);

  const plansGrouped = plans.reduce<Record<string, PricingPlan[]>>(
    (acc, plan) => {
      if (!acc[plan.id]) acc[plan.id] = [];
      acc[plan.id].push(plan);
      return acc;
    },
    {},
  );

  function getActivePlan(planId: string): PricingPlan | undefined {
    const variants = plansGrouped[planId];
    if (!variants || variants.length === 0) return undefined;
    if (planId === "free") return variants[0];
    return variants.find((v) => v.interval === selectedInterval) ?? variants[0];
  }

  const freePlan = getActivePlan("free");
  const proPlan = getActivePlan("pro");

  const handleSubscribe = useCallback(
    async (plan: PricingPlan) => {
      if (!userId) {
        window.location.href = "/login?redirect=/pricing";
        return;
      }
      if (plan.id === "free") return;

      setIsSubscribing(true);
      setSubscribeError(null);

      try {
        const body: Record<string, unknown> = {
          userId,
          plan: plan.id,
          interval: selectedInterval,
        };
        if (userEmail) body.email = userEmail;
        const res = await fetch("/api/billing/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Failed to start checkout");
        }

        if (data.url) {
          window.location.href = data.url;
        }
      } catch (err) {
        setSubscribeError(err instanceof Error ? err.message : "Checkout failed");
        setIsSubscribing(false);
      }
    },
    [userId, userEmail, selectedInterval],
  );

  async function handleManageBilling() {
    setPortalLoading(true);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } catch {
      setPortalLoading(false);
    }
  }

  const hasPlans = plans.length > 0 && (freePlan || proPlan);

  if (!hasPlans) {
    return (
      <div className={styles.stateContainer}>
        <p className={styles.stateText}>No pricing plans available at this time.</p>
        <button className={styles.retryButton} onClick={() => window.location.reload()} type="button">
          Refresh
        </button>
      </div>
    );
  }

  return (
    <>
      <div className={styles.toggle}>
        <button
          className={`${styles.toggleButton} ${selectedInterval === "month" ? styles.toggleButtonActive : ""}`}
          onClick={() => setSelectedInterval("month")}
          type="button"
        >
          Monthly
        </button>
        <button
          className={`${styles.toggleButton} ${selectedInterval === "year" ? styles.toggleButtonActive : ""}`}
          onClick={() => setSelectedInterval("year")}
          type="button"
        >
          Annual
          <span className={styles.saveBadge}>Save ~20%</span>
        </button>
      </div>

      <div className={styles.grid}>
        {freePlan && (
          <div className={styles.tier}>
            <div className={styles.tierHeader}>
              <h3 className={styles.tierName}>Free</h3>
              <p className={styles.tierDesc}>Get started with the basics</p>
            </div>
            <div className={styles.price}>
              <span className={styles.priceValue}>$0</span>
              <span className={styles.priceLabel}>/mo</span>
            </div>
            <div className={styles.features}>
              {freePlan.features.map((text) => (
                <div key={text} className={styles.feature}>
                  <Check size={18} className={styles.checkIcon} />
                  <span className={styles.featureText}>{text}</span>
                </div>
              ))}
            </div>
            {!hasSubscription ? (
              <div className={`${styles.ctaBtn} ${styles.ctaBtnDisabled}`}>
                Current Plan
              </div>
            ) : (
              <div className={styles.ctaBtn}>Free</div>
            )}
          </div>
        )}

        {proPlan && (
          <div className={`${styles.tier} ${proPlan.popular && !hasSubscription ? styles.tierHighlighted : ""}`}>
            {proPlan.popular && !hasSubscription && (
              <div className={styles.badge}>Most Popular</div>
            )}
            {proPlan.popular && hasSubscription && (
              <div className={styles.badge}>Current Plan</div>
            )}
            <div className={styles.tierHeader}>
              <h3 className={styles.tierName}>Pro</h3>
              <p className={styles.tierDesc}>For professionals and small teams</p>
            </div>
            <div className={styles.price}>
              <span className={styles.priceValue}>${formatPrice(proPlan.amount)}</span>
              <span className={styles.priceLabel}>/{formatInterval(selectedInterval)}</span>
            </div>
            <div className={styles.features}>
              {proPlan.features.map((text) => (
                <div key={text} className={styles.feature}>
                  <Check size={18} className={styles.checkIcon} />
                  <span className={styles.featureText}>{text}</span>
                </div>
              ))}
            </div>
            {hasSubscription ? (
              <button
                className={styles.ctaBtn}
                onClick={handleManageBilling}
                disabled={portalLoading}
                type="button"
              >
                {portalLoading ? "Redirecting..." : "Manage Subscription"}
              </button>
            ) : !userId ? (
              <a href="/login?redirect=/pricing" className={styles.ctaBtn}>
                Sign In
              </a>
            ) : (
              <button
                className={styles.ctaBtn}
                onClick={() => handleSubscribe(proPlan)}
                disabled={isSubscribing}
                type="button"
              >
                {isSubscribing ? "Redirecting..." : "Subscribe"}
              </button>
            )}
          </div>
        )}

      </div>

      {subscribeError && (
        <div className={styles.subscribeError}>{subscribeError}</div>
      )}

      {!userId && (
        <div className={styles.loginPrompt}>
          <a href="/login" className={styles.loginLink}>Sign in</a> to subscribe to a paid plan
        </div>
      )}
    </>
  );
}
