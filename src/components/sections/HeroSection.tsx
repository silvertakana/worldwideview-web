"use client";

import { useInView } from "@/hooks/useInView";
import { trackEvent } from "@/lib/analytics";
import Globe from "../Globe";
import styles from "./HeroSection.module.css";

export default function HeroSection() {
  const { ref, isVisible } = useInView(0.1);

  return (
    <section
      ref={ref as React.RefObject<HTMLElement & HTMLDivElement>}
      className={`${styles.hero} ${isVisible ? styles.visible : ""}`}
    >
      <div className={styles.grid}>
        <div className={styles.textContent}>
          <h1 className={styles.heading}>
            Real-time intelligence,{" "}
            <span className={styles.accent}>visualized</span>
          </h1>
          <p className={styles.subtitle}>
            Track aircraft, ships, and signals across the entire planet on
            an interactive 3D globe. Open source, plugin-driven, endlessly
            extensible.
          </p>
          <div className={styles.buttons}>
            <a
              href="https://demo.worldwideview.dev"
              className={styles.primaryBtn}
              onClick={() => trackEvent("cta_click", { label: "Try Demo" })}
            >
              <span style={{ position: "relative", zIndex: 10, color: "#fff" }}>Try Demo</span>
            </a>
            <a
              href="https://github.com/silvertakana/worldwideview"
              className={styles.outlineBtn}
              onClick={() =>
                trackEvent("cta_click", { label: "Download" })
              }
            >
              Download
            </a>
          </div>
        </div>

        <div className={styles.globeWrapper}>
          <Globe />
        </div>
      </div>
    </section>
  );
}
