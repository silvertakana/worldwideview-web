"use client";

import { useInView } from "@/hooks/useInView";
import { trackEvent } from "@/lib/analytics";
import styles from "./CTASection.module.css";

export default function CTASection() {
  const { ref, isVisible } = useInView();

  return (
    <section className={styles.section} ref={ref}>
      <div className={`${styles.inner} ${isVisible ? styles.visible : ""}`}>
        <h2 className={styles.heading}>Start visualizing the world</h2>
        <p className={styles.sub}>
          Clone the repo and run locally in under a minute. Or try the hosted
          demo. No signup required.
        </p>
        <div className={styles.actions}>
          <a
            href="https://demo.worldwideview.dev"
            className={styles.primaryBtn}
            onClick={() => trackEvent("cta_click", { label: "Try the Demo" })}
          >
            Try the Demo
          </a>
          <a
            href="/download"
            className={styles.secondaryBtn}
            onClick={() => trackEvent("cta_click", { label: "Download" })}
          >
            Download
          </a>
        </div>
      </div>
    </section>
  );
}
