import type { Metadata } from "next";
import { Terminal, Monitor, Cpu } from "lucide-react";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Download" };

const REQUIREMENTS = [
  { icon: Monitor, label: "OS", value: "Windows, macOS, or Linux" },
  { icon: Cpu, label: "Node.js", value: "v20 or later" },
  { icon: Terminal, label: "npm", value: "v10 or later" },
];

const STEPS = [
  {
    title: "Clone the repository",
    code: "git clone https://github.com/silvertakana/worldwideview.git",
  },
  {
    title: "Install dependencies",
    code: "cd worldwideview && npm install",
  },
  {
    title: "Start the dev server",
    code: "npm run dev",
  },
  {
    title: "Open in your browser",
    code: "http://localhost:3000",
  },
];

export default function DownloadPage() {
  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Get WorldWideView</h1>
      <p className={styles.sub}>
        Clone from GitHub and have a running instance in under a minute.
      </p>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>System Requirements</h2>
        <div className={styles.reqGrid}>
          {REQUIREMENTS.map((r) => (
            <div key={r.label} className={styles.reqCard}>
              <r.icon size={20} strokeWidth={1.5} className={styles.reqIcon} />
              <div>
                <div className={styles.reqLabel}>{r.label}</div>
                <div className={styles.reqValue}>{r.value}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Quick Start</h2>
        <div className={styles.steps}>
          {STEPS.map((s, i) => (
            <div key={i} className={styles.step}>
              <div className={styles.stepNum}>{i + 1}</div>
              <div className={styles.stepContent}>
                <div className={styles.stepTitle}>{s.title}</div>
                <code className={styles.code}>{s.code}</code>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Prefer hosted?</h2>
        <p className={styles.sub}>
          Skip the setup — get a managed cloud instance with a single click.
        </p>
        <a
          href="https://app.worldwideview.dev/register"
          className={styles.cta}
        >
          Try Cloud — Free
        </a>
      </section>
    </div>
  );
}
