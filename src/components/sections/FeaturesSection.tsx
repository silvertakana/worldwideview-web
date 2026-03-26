"use client";

import { useInView } from "@/hooks/useInView";
import styles from "./FeaturesSection.module.css";

const FEATURES = [
  { icon: "radar", title: "Real-Time Data", desc: "Stream live telemetry from terrestrial and satellite sources with sub-second latency." },
  { icon: "extension", title: "Plugin Ecosystem", desc: "Expand capabilities with specialized modules for aviation, maritime, and signal analysis." },
  { icon: "public", title: "3D Globe Engine", desc: "High-performance WebGL-based engine capable of rendering millions of vectors in real-time." },
  { icon: "code", title: "Open Source", desc: "Transparency and community-driven innovation. Audit our code, contribute to the core." },
];

export default function FeaturesSection() {
  const { ref, isVisible } = useInView(0.1);

  return (
    <section
      ref={ref as React.RefObject<HTMLElement & HTMLDivElement>}
      className={`${styles.section} ${isVisible ? styles.visible : ""}`}
      id="features"
    >
      <div className={styles.header}>
        <h2 className={styles.heading}>Built for geospatial intelligence</h2>
        <div className={styles.accent} />
      </div>
      <div className={styles.grid}>
        {FEATURES.map(({ icon, title, desc }, i) => (
          <div
            key={title}
            className={styles.card}
            style={{ "--i": i } as React.CSSProperties}
          >
            <div className={styles.iconWrap}>
              <span className={`material-symbols-outlined ${styles.icon}`}>
                {icon}
              </span>
            </div>
            <h3 className={styles.cardTitle}>{title}</h3>
            <p className={styles.cardDesc}>{desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
