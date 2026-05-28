"use client";

import Link from "next/link";
import TerminalBlock from "@/components/TerminalBlock";
import AnimateIn from "@/components/AnimateIn";
import styles from "./page.module.css";

const INSTALL_CODE = `# Clone the repository
git clone https://github.com/silvertakana/worldwideview.git

# Install dependencies
cd worldwideview && pnpm install

# Generate .env.local with a secure AUTH_SECRET (first time only)
pnpm setup

# Start the dev server
pnpm dev`;

export default function DownloadContent() {
  return (
    <div className={styles.main}>
      {/* Hero Section */}
      <AnimateIn>
        <header className={styles.hero}>
          <div className={styles.blurGlow} />
          <h1 className={styles.title}>
            Get Started with{" "}
            <span className={styles.accent}>WorldWideView</span>
          </h1>
          <p className={styles.subtitle}>
            Set up your own real-time geospatial intelligence platform.
            Track aircraft, ships, and global signals on an interactive
            3D globe powered by CesiumJS.
          </p>
        </header>
      </AnimateIn>

      {/* Setup Method Grid (Bento Style) */}
      <section className={styles.cardsGrid}>
        <AnimateIn delay={0}>
          <div className={`${styles.platformCard} ${styles.featured}`}>
            <div className={styles.cardContent}>
              <div>
                <span className={`material-symbols-outlined ${styles.cardIcon}`}>
                  code
                </span>
                <h2 className={styles.platformName}>Git Clone</h2>
                <p className={styles.platformSpec}>
                  Recommended for developers
                </p>
              </div>
              <Link
                href="https://github.com/silvertakana/worldwideview"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.downloadBtn}
              >
                View on GitHub
              </Link>
            </div>
            <div className={styles.watermark}>
              <span
                className="material-symbols-outlined"
                style={{ fontSize: "120px" }}
              >
                deployed_code
              </span>
            </div>
          </div>
        </AnimateIn>

        <AnimateIn delay={0.12}>
          <div className={styles.platformCard}>
            <div className={styles.cardContent}>
              <div>
                <span className={`material-symbols-outlined ${styles.cardIcon}`}>
                  deployed_code
                </span>
                <h2 className={styles.platformName}>Docker</h2>
                <p className={styles.platformSpec}>
                  Containerized deployment
                </p>
              </div>
              <Link
                href="https://github.com/silvertakana/worldwideview"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.downloadBtn}
              >
                Get Docker Image
              </Link>
            </div>
          </div>
        </AnimateIn>

        <AnimateIn delay={0.24}>
          <div className={styles.platformCard}>
            <div className={styles.cardContent}>
              <div>
                <span className={`material-symbols-outlined ${styles.cardIcon}`}>
                  cloud
                </span>
                <h2 className={styles.platformName}>Cloud Hosted</h2>
                <p className={styles.platformSpec}>
                  Managed instance, zero setup
                </p>
              </div>
              <Link
                href="/waitlist"
                className={`${styles.downloadBtn} ${styles.downloadBtnAlt}`}
              >
                Join Waitlist
              </Link>
            </div>
          </div>
        </AnimateIn>
      </section>

      {/* Quick Install */}
      <AnimateIn>
        <section className={styles.installSection}>
          <div className={styles.specsHeader}>
            <div className={styles.pulseDot} />
            <h3 className={styles.specsTitle}>Quick Install</h3>
          </div>
          <TerminalBlock code={INSTALL_CODE} title="bash" />
        </section>
      </AnimateIn>

      {/* Requirements & Release Notes */}
      <div className={styles.bottomGrid}>
        <AnimateIn>
          <section>
            <SpecsHeader title="Requirements" />
            <div>
              <SpecRow label="Node.js" value="v20.0.0 or higher" />
              <SpecRow label="pnpm" value="v9 or higher" />
              <SpecRow label="Docker Desktop" value="Required for local database" />
              <SpecRow label="Browser" value="Chrome, Firefox, or Edge (WebGL)" />
              <SpecRow label="API Keys" value="Cesium Ion, Bing Maps" />
            </div>
          </section>
        </AnimateIn>

        <AnimateIn delay={0.15}>
          <ReleaseCard />
        </AnimateIn>
      </div>
    </div>
  );
}

function SpecsHeader({ title }: { title: string }) {
  return (
    <div className={styles.specsHeader}>
      <div className={styles.pulseDot} />
      <h3 className={styles.specsTitle}>{title}</h3>
    </div>
  );
}

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.specRow}>
      <span className={styles.specLabel}>{label}</span>
      <span className={styles.specValue}>{value}</span>
    </div>
  );
}

function ReleaseCard() {
  const notes = [
    "High-performance CesiumJS 3D globe with real-time data rendering.",
    "Modular plugin system for aviation, maritime, wildfire, and military layers.",
    "Live data streaming with sub-second latency from terrestrial and satellite sources.",
  ];
  return (
    <section className={styles.releaseCard}>
      <div className={styles.releaseHeader}>
        <div>
          <h3 className={styles.releaseTitle}>Version 2.20.1</h3>
          <p className={styles.releaseSubtitle}>Early Access</p>
        </div>
        <span className={styles.releaseBadge}>Latest</span>
      </div>
      <ul>
        {notes.map((text, i) => (
          <li key={i} className={styles.releaseItem}>
            <span className={styles.releaseNum}>
              {String(i + 1).padStart(2, "0")}
            </span>
            <p className={styles.releaseText}>{text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
