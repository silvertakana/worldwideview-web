"use client";

import { Radar, Puzzle, Globe2, Code2 } from "lucide-react";
import { useInView } from "@/hooks/useInView";
import styles from "./FeaturesSection.module.css";

const FEATURES = [
  {
    icon: Radar,
    title: "Real-Time Data",
    desc: "Ingest live ADS-B, AIS, and satellite feeds. Watch aircraft, ships, and signals move across the planet in real time.",
  },
  {
    icon: Puzzle,
    title: "Plugin Ecosystem",
    desc: "Install data layers from the marketplace or build your own. Each plugin is a self-contained module with its own API.",
  },
  {
    icon: Globe2,
    title: "3D Globe Engine",
    desc: "Powered by CesiumJS with high-performance primitives. Supports terrain, imagery layers, and thousands of entities.",
  },
  {
    icon: Code2,
    title: "Open Source",
    desc: "Clone, run, and customize. The core is open under the Elastic License 2.0 with full code visibility and commercial protection.",
  },
];

export default function FeaturesSection() {
  const { ref, isVisible } = useInView();

  return (
    <section id="features" className={styles.section} ref={ref}>
      <div className={`${styles.inner} ${isVisible ? styles.visible : ""}`}>
        <h2 className={styles.heading}>Built for geospatial intelligence</h2>
        <p className={styles.sub}>
          Everything you need to monitor, analyze, and visualize global data
          streams.
        </p>
        <div className={styles.grid}>
          {FEATURES.map((f) => (
            <div key={f.title} className={styles.card}>
              <div className={styles.iconWrap}>
                <f.icon size={24} strokeWidth={1.5} />
              </div>
              <h3 className={styles.cardTitle}>{f.title}</h3>
              <p className={styles.cardDesc}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
