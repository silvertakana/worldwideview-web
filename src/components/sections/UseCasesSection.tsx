"use client";

import { Plane, Ship, Eye, Shield } from "lucide-react";
import { useInView } from "@/hooks/useInView";
import styles from "./UseCasesSection.module.css";

const CASES = [
  {
    icon: Plane,
    title: "Aviation Tracking",
    desc: "Monitor global air traffic with live ADS-B feeds. See flight paths, altitude profiles, and aircraft metadata in real time.",
  },
  {
    icon: Ship,
    title: "Maritime Intelligence",
    desc: "Track vessels across every ocean using AIS data. Identify routes, port activity, and anomalous behavior.",
  },
  {
    icon: Eye,
    title: "OSINT & Situational Awareness",
    desc: "Aggregate open-source intelligence on a single canvas. Layer conflict data, satellite imagery, and sensor feeds.",
  },
  {
    icon: Shield,
    title: "Defense & Security",
    desc: "Visualize military deployments, airspace boundaries, and critical infrastructure on a secure, self-hosted instance.",
  },
];

export default function UseCasesSection() {
  const { ref, isVisible } = useInView();

  return (
    <section className={styles.section} ref={ref}>
      <div className={`${styles.inner} ${isVisible ? styles.visible : ""}`}>
        <h2 className={styles.heading}>Use cases</h2>
        <p className={styles.sub}>
          From flight tracking to conflict monitoring — one platform, infinite
          layers.
        </p>
        <div className={styles.list}>
          {CASES.map((c) => (
            <div key={c.title} className={styles.item}>
              <div className={styles.iconWrap}>
                <c.icon size={22} strokeWidth={1.5} />
              </div>
              <div>
                <h3 className={styles.itemTitle}>{c.title}</h3>
                <p className={styles.itemDesc}>{c.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
