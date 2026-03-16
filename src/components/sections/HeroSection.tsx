"use client";

import Globe from "../Globe";
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
            href="https://demo.app.worldwideview.dev"
            className={styles.primaryBtn}
          >
            Try Demo
          </a>
          <a
            href="https://app.worldwideview.dev/register"
            className={styles.secondaryBtn}
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
