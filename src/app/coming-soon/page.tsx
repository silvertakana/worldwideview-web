import type { Metadata } from "next";
import Link from "next/link";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Coming Soon" };

export default function ComingSoonPage() {
  return (
    <div className={styles.page}>
      <span className={styles.badge}>Coming Soon</span>
      <h1 className={styles.heading}>
        This page is under construction
      </h1>
      <p className={styles.sub}>
        We&apos;re working on something great. Check back soon or join the
        waitlist to be notified when this is ready.
      </p>
      <div className={styles.actions}>
        <Link href="/waitlist" className={styles.primaryBtn}>
          Join Waitlist
        </Link>
        <Link href="/" className={styles.secondaryBtn}>
          Back to Home
        </Link>
      </div>
    </div>
  );
}
