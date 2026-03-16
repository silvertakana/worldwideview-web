import type { Metadata } from "next";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "About" };

export default function AboutPage() {
  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>About WorldWideView</h1>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Mission</h2>
        <p className={styles.text}>
          WorldWideView exists to democratize geospatial intelligence. We
          believe that real-time situational awareness shouldn&#39;t be locked
          behind expensive, proprietary platforms. By combining open-source
          principles with a powerful plugin ecosystem, we&#39;re building the
          tools that let anyone visualize global data streams on a 3D globe.
        </p>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Technology</h2>
        <p className={styles.text}>
          Built on <strong>Next.js</strong> and <strong>CesiumJS</strong>,
          WorldWideView uses high-performance rendering primitives to display
          thousands of real-time entities simultaneously. The plugin system
          follows the VS Code extension model — plugins run in the browser,
          declare capabilities upfront, and are lazily loaded on demand.
        </p>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Open Source</h2>
        <p className={styles.text}>
          The core application is licensed under the{" "}
          <strong>Elastic License 2.0</strong> — full source code visibility
          with commercial protection. The plugin SDK is MIT-licensed, ensuring
          that anyone can build and distribute plugins freely. We follow the
          same model as n8n, CesiumJS, and other infrastructure-grade open source
          projects.
        </p>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Get Involved</h2>
        <p className={styles.text}>
          WorldWideView is built in the open. Contributions are welcome —
          whether it&#39;s a new plugin, a bug fix, or documentation
          improvements. Check out the{" "}
          <a href="https://github.com/silvertakana/worldwideview">
            GitHub repository
          </a>{" "}
          to get started.
        </p>
      </section>
    </div>
  );
}
