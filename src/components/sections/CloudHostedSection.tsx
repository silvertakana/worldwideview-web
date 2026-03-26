"use client";

import { useInView } from "@/hooks/useInView";
import { trackEvent } from "@/lib/analytics";
import styles from "./CloudHostedSection.module.css";

export default function CloudHostedSection() {
  const { ref, isVisible } = useInView(0.1);

  return (
    <section
      ref={ref as React.RefObject<HTMLElement & HTMLDivElement>}
      className={`${styles.section} ${isVisible ? styles.visible : ""}`}
      id="cloud"
    >
      <h2 className={styles.heading}>
        Cloud hosted <span className={styles.headingAccent}>instance</span>
      </h2>
      <div className={styles.grid}>
        <div className={styles.cardLarge} style={{ "--i": 0 } as React.CSSProperties}>
          <div>
            <div className={`${styles.iconBox} ${styles.iconPrimary}`}>
              <span className="material-symbols-outlined">shield</span>
            </div>
            <h3 className={styles.cardTitle}>Managed Infrastructure</h3>
            <p className={styles.cardDesc}>
              Enterprise-grade uptime, backups, and security so you can
              focus on analysis, not ops. We handle the scaling and
              ingestion pipelines.
            </p>
          </div>
          <div className={styles.divider}>
            <div className={styles.avatars}>
              <div className={`${styles.avatar} ${styles.avatarGray}`}>
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>group</span>
              </div>
              <div className={`${styles.avatar} ${styles.avatarGray}`}>
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>group</span>
              </div>
              <div className={`${styles.avatar} ${styles.avatarBrand}`}>+50</div>
            </div>
          </div>
        </div>

        <div className={styles.cardMedium} style={{ "--i": 1 } as React.CSSProperties}>
          <div>
            <div className={`${styles.iconBox} ${styles.iconTertiary}`}>
              <span className="material-symbols-outlined">bolt</span>
            </div>
            <h3 className={styles.cardTitle}>Zero Setup</h3>
            <p className={styles.cardDesc}>
              No servers to provision, no Docker to configure. Launch your
              private instance in under 60 seconds with pre-configured
              data feeds.
            </p>
          </div>
        </div>

        <SmallCard i={2} icon="refresh" title="Auto-Updates" desc="Always running the latest version with new plugins and features shipped automatically." />
        <SmallCard i={3} icon="group" title="Team Collaboration" desc="Invite your team to a shared globe instance with real-time synchronized views." />
        <SmallCard i={4} icon="cloud" title="Always-On Availability" desc="Access your globe from any device, anywhere. Your data and layers persist across sessions." />
      </div>

      <div className={styles.cta}>
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
    </section>
  );
}

function SmallCard({ i, icon, title, desc }: { i: number; icon: string; title: string; desc: string }) {
  return (
    <div className={styles.cardSmall} style={{ "--i": i } as React.CSSProperties}>
      <span className={`material-symbols-outlined ${styles.smallIcon}`}>{icon}</span>
      <h4 className={styles.smallTitle}>{title}</h4>
      <p className={styles.smallDesc}>{desc}</p>
    </div>
  );
}
