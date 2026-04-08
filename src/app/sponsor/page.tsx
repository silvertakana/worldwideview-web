import React from "react";
import type { Metadata } from "next";
import styles from "./Sponsor.module.css";

export const metadata: Metadata = {
  title: "Sponsor",
  description: "Support the development of WorldWideView by becoming a sponsor.",
};

export default function SponsorPage() {
  return (
    <div className={styles.container}>
      <div className={styles.gradient} />
      
      <div className={styles.inner}>
        <h1 className={styles.heading}>Sponsor WorldWideView</h1>
        <p className={styles.description}>
          WorldWideView is completely open source and community-driven. 
          Your sponsorship helps fund server costs, dedicated development time, 
          and ensures the engine remains freely available for everyone.
        </p>

        <div className={styles.card}>
          <div className={styles.iframeWrapper}>
            <iframe 
              src="https://github.com/sponsors/silvertakana/card" 
              title="Sponsor silvertakana" 
              height="225" 
              width="600" 
              style={{ border: 0, width: "100%", maxWidth: "600px" }}
            ></iframe>
          </div>
        </div>
      </div>
    </div>
  );
}
