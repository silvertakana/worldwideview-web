"use client";

import Link from "next/link";
import ThemeToggle from "./ThemeToggle";
import styles from "./Header.module.css";

const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/pricing", label: "Pricing" },
  { href: "/download", label: "Download" },
  { href: "/plugins", label: "Plugins" },
  { href: "/about", label: "About" },
];

export default function Header() {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Link href="/" className={styles.logo}>
          <span className={styles.logoIcon}>◆</span>
          <span className={styles.logoText}>WorldWideView</span>
        </Link>

        <nav className={styles.nav}>
          {NAV_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className={styles.navLink}>
              {link.label}
            </Link>
          ))}
        </nav>

        <div className={styles.actions}>
          <ThemeToggle />
          <a
            href="https://app.worldwideview.dev/login"
            className={styles.signIn}
          >
            Sign In
          </a>
          <a
            href="https://app.worldwideview.dev/register"
            className={styles.getStarted}
          >
            Get Started
          </a>
        </div>
      </div>
    </header>
  );
}
