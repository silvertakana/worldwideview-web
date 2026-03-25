import type { Metadata } from "next";
import { Check } from "lucide-react";
import TrackedLink from "@/components/TrackedLink";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Pricing" };

const TIERS = [
  {
    name: "Local: Free",
    price: "$0",
    period: "forever",
    desc: "Clone, run, and own your data.",
    features: [
      "Full 3D globe engine",
      "Unlimited storage (your disk)",
      "All built-in plugins",
      "Marketplace plugin install",
      "Community support",
    ],
    cta: { label: "Download", href: "/download" },
    highlight: false,
  },
  {
    name: "Cloud: Free",
    price: "$0",
    period: "/month",
    desc: "Hosted instance, zero setup.",
    features: [
      "Everything in Local Free",
      "Managed hosting",
      "3 user seats",
      "500 MB storage",
      "Auto-updates",
    ],
    cta: { label: "Join Waitlist", href: "/waitlist" },
    highlight: true,
  },
  {
    name: "Cloud: Pro",
    price: "TBD",
    period: "/month",
    desc: "For teams and power users.",
    features: [
      "Everything in Cloud Free",
      "20 user seats",
      "5 GB storage",
      "Snapshot history capture",
      "Priority support",
    ],
    cta: { label: "Join Waitlist", href: "/waitlist" },
    highlight: false,
  },
];

export default function PricingPage() {
  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Simple, transparent pricing</h1>
      <p className={styles.sub}>
        Start free. Scale when you&#39;re ready.
      </p>
      <div className={styles.grid}>
        {TIERS.map((t) => (
          <div
            key={t.name}
            className={`${styles.card} ${t.highlight ? styles.highlight : ""}`}
          >
            <h2 className={styles.tierName}>{t.name}</h2>
            <div className={styles.priceRow}>
              <span className={styles.price}>{t.price}</span>
              <span className={styles.period}>{t.period}</span>
            </div>
            <p className={styles.tierDesc}>{t.desc}</p>
            <ul className={styles.features}>
              {t.features.map((f) => (
                <li key={f} className={styles.feature}>
                  <Check size={16} /> {f}
                </li>
              ))}
            </ul>
            <TrackedLink
              href={t.cta.href}
              className={styles.cta}
              eventName="pricing_cta_click"
              eventData={{ tier: t.name, label: t.cta.label }}
            >
              {t.cta.label}
            </TrackedLink>
          </div>
        ))}
      </div>
    </div>
  );
}
