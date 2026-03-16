"use client";

import dynamic from "next/dynamic";
import styles from "./Globe.module.css";

const GlobeCanvas = dynamic(() => import("./GlobeCanvas"), { ssr: false });

export default function Globe() {
  return (
    <div className={styles.wrapper}>
      <div className={styles.glow} />
      <GlobeCanvas />
    </div>
  );
}
