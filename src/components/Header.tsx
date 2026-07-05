'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { trackEvent } from '@/lib/analytics';
import { BILLING_ENABLED } from '@/lib/billing/constants';
import { diceBearUrl } from '@/lib/diceBear';
import styles from './Header.module.css';

const NAV_LINKS = [
  { label: 'Home', href: '/' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Download', href: '/download' },
  { label: 'Docs', href: '/docs' },
  { label: 'Marketplace', href: process.env.NEXT_PUBLIC_MARKETPLACE_URL ?? "https://marketplace.worldwideview.dev/" },
];

export default function Header({ initialUser = null }: { initialUser?: User | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const [activePath, setActivePath] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [user, setUser] = useState<User | null>(initialUser);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const closeDropdown = useCallback(() => {
    setDropdownOpen(false);
  }, []);

  useEffect(() => {
    setActivePath(pathname);
  }, [pathname]);

  useEffect(() => {
    closeDropdown();
  }, [pathname, closeDropdown]);

  useEffect(() => {
    const supabase = createClient();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      if (event === 'SIGNED_IN') router.refresh();
    });
    return () => subscription.unsubscribe();
  }, [router]);

  useEffect(() => {
    if (!dropdownOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeDropdown();
    }
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        closeDropdown();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClick);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [dropdownOpen, closeDropdown]);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/');
  }

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
        </div>

        <div className={styles.actions}>
          {user ? (
            <div className={styles.avatarWrapper} ref={dropdownRef}>
              <button
                className={styles.avatarBtn}
                onClick={() => setDropdownOpen((v) => !v)}
                aria-expanded={dropdownOpen}
                aria-haspopup="true"
                aria-label="User menu"
                title={user.email ?? ''}
              >
                <img
                  src={user.user_metadata?.avatar_url || diceBearUrl(user.id)}
                  alt=""
                  className={styles.avatarImg}
                />
              </button>
              {dropdownOpen && (
                <div className={styles.dropdown} role="menu">
                  <Link href="/accounts" className={styles.dropdownItem} role="menuitem" onClick={closeDropdown}>
                    Account Dashboard
                  </Link>
                  {BILLING_ENABLED && (
                    <Link href="/accounts/billing" className={styles.dropdownItem} role="menuitem" onClick={closeDropdown}>
                      Billing
                    </Link>
                  )}
                  <Link href="/redeem" className={styles.dropdownItem} role="menuitem" onClick={closeDropdown}>
                    Redeem Code
                  </Link>
                  <div className={styles.dropdownDivider} />
                  <button className={`${styles.dropdownItem} ${styles.dropdownItemDanger}`} role="menuitem" onClick={handleSignOut}>
                    Sign Out
                  </button>
                </div>
              )}
            </div>
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
        {user && (
          <>
            <Link
              href="/accounts"
              className={`${styles.mobileLink} ${
                activePath === '/accounts' ? styles.mobileLinkActive : ''
              }`}
              onClick={() => setMenuOpen(false)}
            >
              Account Dashboard
            </Link>
            {BILLING_ENABLED && (
              <Link
                href="/accounts/billing"
                className={`${styles.mobileLink} ${
                  activePath === '/accounts/billing' ? styles.mobileLinkActive : ''
                }`}
                onClick={() => setMenuOpen(false)}
              >
                Billing
              </Link>
            )}
            <Link
              href="/redeem"
              className={`${styles.mobileLink} ${
                activePath === '/redeem' ? styles.mobileLinkActive : ''
              }`}
              onClick={() => setMenuOpen(false)}
            >
              Redeem Code
            </Link>
            <button
              className={`${styles.mobileLink} ${styles.mobileSignOut}`}
              onClick={() => { setMenuOpen(false); handleSignOut(); }}
            >
              Sign Out
            </button>
          </>
        )}
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
