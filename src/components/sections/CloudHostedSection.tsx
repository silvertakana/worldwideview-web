"use client";

import { Cloud, Zap, Users, RefreshCw, Shield } from "lucide-react";
import { useInView } from "@/hooks/useInView";
import { trackEvent } from "@/lib/analytics";
import styles from "./CloudHostedSection.module.css";

const BENEFITS = [
  {
    icon: Zap,
    title: "Zero Setup",
    desc: "No servers to provision, no Docker to configure. Sign up and you're live in seconds.",
  },
  {
    icon: RefreshCw,
    title: "Auto-Updates",
    desc: "Always running the latest version with new plugins and features shipped automatically.",
  },
  {
    icon: Users,
    title: "Team Collaboration",
    desc: "Invite your team to a shared globe instance with real-time synchronized views.",
  },
  {
    icon: Shield,
    title: "Managed Infrastructure",
    desc: "Enterprise-grade uptime, backups, and security so you can focus on intelligence, not ops.",
  },
  {
    icon: Cloud,
    title: "Always-On Availability",
    desc: "Access your globe from any device, anywhere. Your data and layers persist across sessions.",
  },
];

export default function CloudHostedSection() {
  const { ref, isVisible } = useInView();

  return (
    <section className={styles.section} ref={ref}>
      <div className={`${styles.inner} ${isVisible ? styles.visible : ""}`}>
        <h2 className={styles.heading}>
          Cloud hosted <span className={styles.accent}>instance</span>
        </h2>
        <p className={styles.sub}>
          Skip the setup. Get a fully managed WorldWideView instance in the
          cloud. Always up to date, always available, ready for your team.
        </p>
        <div className={styles.grid}>
          {BENEFITS.map((b) => (
            <div key={b.title} className={styles.card}>
              <div className={styles.iconWrap}>
                <b.icon size={20} strokeWidth={1.5} />
              </div>
              <h3 className={styles.cardTitle}>{b.title}</h3>
              <p className={styles.cardDesc}>{b.desc}</p>
            </div>
          ))}
        </div>
        <div className={styles.ctaWrap}>
          <a
            href="/waitlist"
            className={styles.ctaBtn}
            onClick={() =>
              trackEvent("cta_click", { label: "Join Waitlist: Cloud" })
            }
          >
            Join Waitlist
          </a>
        </div>
      </div>
    </section>
  );
}
