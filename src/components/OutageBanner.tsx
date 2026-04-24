"use client";

import { siteConfig } from "@/config/site";
import styles from "./OutageBanner.module.css";

export default function OutageBanner() {
  if (!siteConfig.outageActive) {
    return null;
  }

  return (
    <div className={styles.banner}>
      <span className={styles.pulse}></span>
      <span>
        <span className={styles.bold}>Planned Maintenance:</span> The WorldWideView server is currently down. Please wait a few hours until the system is back online.
      </span>
    </div>
  );
}
