"use client";

import { useInView } from "@/hooks/useInView";
import styles from "./CTASection.module.css";

export default function CTASection() {
  const { ref, isVisible } = useInView();

  return (
    <section className={styles.section} ref={ref}>
      <div className={`${styles.inner} ${isVisible ? styles.visible : ""}`}>
        <h2 className={styles.heading}>Start visualizing the world</h2>
        <p className={styles.sub}>
          Clone the repo and run locally in under a minute. Or try the hosted
          demo — no signup required.
        </p>
        <div className={styles.actions}>
          <a
            href="https://demo.app.worldwideview.dev"
            className={styles.primaryBtn}
          >
            Try the Demo
          </a>
          <a href="/download" className={styles.secondaryBtn}>
            Download
          </a>
        </div>
      </div>
    </section>
  );
}
