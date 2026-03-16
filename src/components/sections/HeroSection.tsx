"use client";

import Globe from "../Globe";
import { trackEvent } from "@/lib/analytics";
import styles from "./HeroSection.module.css";

export default function HeroSection() {
  return (
    <section className={styles.hero}>
      <div className={styles.content}>
        <h1 className={styles.headline}>
          Real-time intelligence,{" "}
          <span className={styles.accent}>visualized</span>
        </h1>
        <p className={styles.subtitle}>
          Track aircraft, ships, and signals across the entire planet on an
          interactive 3D globe. Open source, plugin-driven, endlessly
          extensible.
        </p>
        <div className={styles.actions}>
          <a
            href="https://demo.worldwideview.dev"
            className={styles.primaryBtn}
            onClick={() => trackEvent("cta_click", { label: "Try Demo" })}
          >
            Try Demo
          </a>
          <a
            href="https://app.worldwideview.dev/register"
            className={styles.secondaryBtn}
            onClick={() => trackEvent("cta_click", { label: "Get Started" })}
          >
            Get Started
          </a>
        </div>
      </div>
      <div className={styles.globe}>
        <Globe />
      </div>
    </section>
  );
}
