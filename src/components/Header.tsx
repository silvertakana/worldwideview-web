'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { trackEvent } from '@/lib/analytics';
import { diceBearUrl } from '@/lib/diceBear';
import styles from './Header.module.css';

const NAV_LINKS = [
  { label: 'Home', href: '/' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Download', href: '/download' },
  { label: 'Docs', href: '/docs' },
  { label: 'Marketplace', href: 'https://marketplace.worldwideview.dev/' },
  { label: 'Sponsor', href: '/sponsor' },
  { label: 'About', href: '/about' },
];

const AUTH_NAV_LINKS = [
  { label: 'Account', href: '/accounts' },
];

export default function Header() {
  const pathname = usePathname();
  const [activePath, setActivePath] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [user, setUser] = useState<User | null>(null);

  // Defer pathname comparison to after client mount to prevent hydration
  // mismatch on statically prerendered pages when proxy.ts is present (Next.js 16).
  useEffect(() => {
    setActivePath(pathname);
  }, [pathname]);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setUser(data.user));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

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
                activePath === href
                  ? `${styles.link} ${styles.linkActive}`
                  : styles.link
              }
            >
              {label}
            </Link>
          ))}
          {user && AUTH_NAV_LINKS.map(({ label, href }) => (
            <Link
              key={href}
              href={href}
              className={
                activePath === href
                  ? `${styles.link} ${styles.linkActive}`
                  : styles.link
              }
            >
              {label}
            </Link>
          ))}
        </div>

        <div className={styles.actions}>
          {user ? (
            <Link
              href="/accounts"
              className={styles.avatarChip}
              title={user.email ?? ''}
            >
              <img
                src={diceBearUrl(
                  user.user_metadata?.display_name ||
                  user.user_metadata?.full_name ||
                  user.user_metadata?.name ||
                  user.email ||
                  'user'
                )}
                alt=""
                className={styles.avatarImg}
              />
            </Link>
          ) : (
            <Link
              href="/login"
              className={styles.signIn}
              onClick={() => trackEvent('cta_click', { label: 'Sign In' })}
            >
              Sign In
            </Link>
          )}
          {!user && (
            <a
              href="/waitlist"
              className={`${styles.waitlistBtn} ${styles.headerWaitlist}`}
              onClick={() =>
                trackEvent('cta_click', { label: 'Join Waitlist' })
              }
            >
              Join Waitlist
            </a>
          )}
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
              activePath === href ? styles.mobileLinkActive : ''
            }`}
            onClick={() => setMenuOpen(false)}
          >
            {label}
          </Link>
        ))}
        {user && AUTH_NAV_LINKS.map(({ label, href }) => (
          <Link
            key={href}
            href={href}
            className={`${styles.mobileLink} ${
              activePath === href ? styles.mobileLinkActive : ''
            }`}
            onClick={() => setMenuOpen(false)}
          >
            {label}
          </Link>
        ))}
        {!user && (
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
        )}
      </div>
    </header>
  );
}
