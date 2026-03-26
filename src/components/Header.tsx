'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { trackEvent } from '@/lib/analytics';
import ThemeToggle from './ThemeToggle';
import styles from './Header.module.css';

const NAV_LINKS = [
  { label: 'Home', href: '/' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Download', href: '/download' },
  { label: 'Marketplace', href: 'https://marketplace.worldwideview.dev/' },
  { label: 'About', href: '/about' },
];

export default function Header() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className={styles.header}>
      <nav className={styles.nav}>
        <Link href="/" className={styles.brand}>
          <img
            src="/logo/logo-icon.svg"
            alt="WorldWideView"
            className={styles.brandLogo}
          />
          WORLD WIDE VIEW
        </Link>

        <div className={styles.links}>
          {NAV_LINKS.map(({ label, href }) => (
            <Link
              key={href}
              href={href}
              className={
                pathname === href
                  ? `${styles.link} ${styles.linkActive}`
                  : styles.link
              }
            >
              {label}
            </Link>
          ))}
        </div>

        <div className={styles.actions}>
          <ThemeToggle />
          <a
            href="/coming-soon"
            className={styles.signIn}
            onClick={() => trackEvent('cta_click', { label: 'Sign In' })}
          >
            Sign In
          </a>
          <a
            href="/waitlist"
            className={styles.waitlistBtn}
            onClick={() =>
              trackEvent('cta_click', { label: 'Join Waitlist' })
            }
          >
            Join Waitlist
          </a>
          <button
            className={styles.menuBtn}
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Toggle menu"
          >
            <span className="material-symbols-outlined">
              {menuOpen ? 'close' : 'menu'}
            </span>
          </button>
        </div>
      </nav>

      {/* Mobile drawer */}
      <div
        className={`${styles.mobileMenu} ${
          menuOpen ? styles.mobileMenuOpen : ''
        }`}
      >
        {NAV_LINKS.map(({ label, href }) => (
          <Link
            key={href}
            href={href}
            className={`${styles.mobileLink} ${
              pathname === href ? styles.mobileLinkActive : ''
            }`}
            onClick={() => setMenuOpen(false)}
          >
            {label}
          </Link>
        ))}
        <div className={styles.mobileCta}>
          <a
            href="/waitlist"
            className={styles.waitlistBtn}
            onClick={() => {
              setMenuOpen(false);
              trackEvent('cta_click', { label: 'Join Waitlist' });
            }}
          >
            Join Waitlist
          </a>
        </div>
      </div>
    </header>
  );
}
