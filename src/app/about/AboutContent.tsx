"use client";

import AnimateIn from "@/components/AnimateIn";
import styles from "./page.module.css";

export default function AboutContent() {
  return (
    <div className={styles.main}>
      {/* Hero */}
      <AnimateIn>
        <header className={styles.hero}>
          <h1 className={styles.heroTitle}>About WorldWideView</h1>
          <div className={styles.accentBar} />
          <div className={styles.heroImageWrap}>
            <img
              className={styles.heroImage}
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuDFTNatK-9Oyf95a7s0L_efUUEsKT_fA1E1Wh80V8AheAnspeSZuC38eQmeoMc2jHJvrBMqTL2NLmK6xu9VEE7bfsPWBwMjqYaNAI00lFStl3LO9hytzp4hXc_gz171iwih06mkuJPqnQiS9AKm69eWt9j10X7tJ2z7RjulxntdFF3I2DZRQ1mfC99XMe47IgoFCB1qLIixT-FWPqBEzHbZzgkYHStyy1dKYiy_qIGvKMprBZLfFtrg32i1HDctr53xN4skbZkgIX2N"
              alt="Satellite view of Earth at night with glowing city lights"
            />
            <div className={styles.heroImageOverlay} />
          </div>
        </header>
      </AnimateIn>

      <div className={styles.content}>
        {/* Mission */}
        <AnimateIn>
          <section className={styles.section}>
            <SectionHeader icon="rocket_launch" title="Mission" />
            <p className={styles.sectionText}>
              WorldWideView exists to democratize geospatial intelligence. We
              believe that real-time situational awareness should not be locked
              behind expensive, proprietary platforms. By combining open-source
              principles with a powerful plugin ecosystem, we are building the
              tools that let anyone visualize global data streams on a 3D globe.
            </p>
          </section>
        </AnimateIn>

        {/* Technology */}
        <AnimateIn>
          <div className={styles.techCard}>
            <span className={`material-symbols-outlined ${styles.techWatermark}`}>
              memory
            </span>
            <div className={styles.techContent}>
              <SectionHeader icon="settings_input_component" title="Technology" />
              <p className={styles.sectionText}>
                Built on <strong>Next.js</strong> and <strong>CesiumJS</strong>,
                WorldWideView uses high-performance rendering primitives to
                display thousands of real-time entities simultaneously. The
                plugin system follows the VS Code extension model. Plugins run
                in the browser, declare capabilities upfront, and are lazily
                loaded on demand.
              </p>
            </div>
          </div>
        </AnimateIn>

        {/* Open Source */}
        <AnimateIn>
          <section className={styles.section}>
            <SectionHeader icon="hub" title="Open Source" />
            <p className={styles.sectionText}>
              The core application is licensed under the{" "}
              <strong>Elastic License 2.0</strong> with full source code
              visibility and commercial protection. The plugin SDK is
              MIT-licensed, ensuring that anyone can build and distribute
              plugins freely. We follow the same model as n8n, CesiumJS, and
              other infrastructure-grade open source projects.
            </p>
          </section>
        </AnimateIn>

        {/* Get Involved CTA */}
        <AnimateIn>
          <section className={styles.ctaSection}>
            <div className={styles.ctaIconWrap}>
              <span className={`material-symbols-outlined ${styles.sectionIcon}`}>
                groups
              </span>
            </div>
            <h2 className={styles.ctaTitle}>Get Involved</h2>
            <p className={styles.ctaText}>
              WorldWideView is built in the open. Contributions are welcome,
              whether it is a new plugin, a bug fix, or documentation
              improvements.
            </p>
            <a
              className={styles.ctaButton}
              href="https://github.com/silvertakana/worldwideview"
              target="_blank"
              rel="noopener noreferrer"
            >
              Check out the GitHub repository
              <span className="material-symbols-outlined" style={{ fontSize: "1rem" }}>
                open_in_new
              </span>
            </a>
          </section>
        </AnimateIn>
      </div>
    </div>
  );
}

function SectionHeader({ icon, title }: { icon: string; title: string }) {
  return (
    <div className={styles.sectionHeader}>
      <span className={`material-symbols-outlined ${styles.sectionIcon}`}>
        {icon}
      </span>
      <h2 className={styles.sectionTitle}>{title}</h2>
    </div>
  );
}
