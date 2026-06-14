"use client";

import { Check } from "lucide-react";
import TrackedLink from "@/components/TrackedLink";
import AnimateIn from "@/components/AnimateIn";
import styles from "./page.module.css";

const TIERS = [
  {
    name: "Local: Free",
    desc: "Clone, run, and own your data.",
    price: "$0",
    label: "forever",
    highlighted: false,
    cta: { label: "Download", href: "/download" },
    features: [
      { text: "Full 3D globe engine", inherited: false },
      { text: "Unlimited storage (your disk)", inherited: false },
      { text: "All built-in plugins", inherited: false },
      { text: "Marketplace plugin install", inherited: false },
      { text: "Community support", inherited: false },
    ],
  },
  {
    name: "Cloud: Pro",
    desc: "Full cloud instance with real-time data, team collaboration, and all plugins.",
    price: "$19",
    label: "/month",
    highlighted: true,
    cta: { label: "Start Free Trial", href: "/provision?plan=pro" },
    features: [
      { text: "Everything in Local Free", inherited: true },
      { text: "Zero setup & managed hosting", inherited: false },
      { text: "Google 3D Tiles included", inherited: false },
      { text: "Access to all live data layers", inherited: false },
      { text: "Team collaboration (up to 5 seats)", inherited: false },
    ],
  },
];

export default function PricingContent() {
  return (
    <div className={styles.page}>
      <div className={styles.glowTL} />
      <div className={styles.glowBR} />

      <AnimateIn>
        <section className={styles.hero}>
          <h1 className={styles.heading}>Simple, transparent pricing</h1>
          <p className={styles.subtitle}>
            Start free. Scale when you&#39;re ready.
          </p>
        </section>
      </AnimateIn>

      <section className={styles.grid}>
        {TIERS.map((tier, i) => (
          <AnimateIn key={tier.name} delay={i * 0.12}>
            <div
              className={`${styles.tier} ${
                tier.highlighted ? styles.tierHighlighted : ""
              }`}
            >
              {tier.highlighted && (
                <div className={styles.badge}>Most Popular</div>
              )}
              <div className={styles.tierHeader}>
                <h3 className={styles.tierName}>{tier.name}</h3>
                <p className={styles.tierDesc}>{tier.desc}</p>
              </div>
              <div className={styles.price}>
                <span className={styles.priceValue}>{tier.price}</span>
                <span className={styles.priceLabel}>{tier.label}</span>
              </div>
              <div className={styles.features}>
                {tier.features.map(({ text, inherited }) => (
                  <div key={text} className={styles.feature}>
                    <Check size={18} className={styles.checkIcon} />
                    <span
                      className={`${styles.featureText} ${
                        inherited ? styles.featureInherited : ""
                      }`}
                    >
                      {text}
                    </span>
                  </div>
                ))}
              </div>
              <TrackedLink
                href={tier.cta.href}
                className={styles.ctaBtn}
                eventName="pricing_cta_click"
                eventData={{ tier: tier.name, label: tier.cta.label }}
              >
                {tier.cta.label}
              </TrackedLink>
            </div>
          </AnimateIn>
        ))}
      </section>

      <AnimateIn delay={0.2}>
        <section className={styles.enterprise}>
          <div className={styles.enterpriseCard}>
            <div className={styles.enterpriseGlow} />
            <h4 className={styles.enterpriseTitle}>Enterprise</h4>
            <p className={styles.enterpriseDesc}>
              Custom deployment, air-gapped environments, dedicated infrastructure.
              Available for organizations with specific security requirements.
            </p>
            <span className={styles.enterpriseLink} style={{ opacity: 0.5, cursor: 'default' }}>
              <span>Coming Soon</span>
              <span className="material-symbols-outlined">schedule</span>
            </span>
          </div>
        </section>
      </AnimateIn>

    </div>
  );
}
