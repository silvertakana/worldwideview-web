"use client";

import { useInView } from "@/hooks/useInView";
import { trackEvent } from "@/lib/analytics";
import styles from "./CTASection.module.css";

export default function CTASection() {
  const { ref, isVisible } = useInView(0.1);

  return (
    <section
      ref={ref as React.RefObject<HTMLElement & HTMLDivElement>}
      className={`${styles.section} ${isVisible ? styles.visible : ""}`}
    >
      <div className={styles.gradient} />
      <div className={styles.inner}>
        <h2 className={styles.heading}>Start visualizing the world</h2>
        <div className={styles.buttons}>
          <a
            href="https://demo.worldwideview.dev"
            className={styles.primaryBtn}
            onClick={() => trackEvent("cta_click", { label: "Try the Demo" })}
          >
            <span style={{ position: "relative", zIndex: 10, color: "#fff" }}>Try the Demo</span>
          </a>
          <a
            href="/download"
            className={styles.outlineBtn}
            onClick={() => trackEvent("cta_click", { label: "Download" })}
          >
            Download
          </a>
        </div>
      </div>
    </section>
  );
}
