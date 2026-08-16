'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { resolveCookieDomain } from '@/lib/supabase/cookieOptions';
import { clearSignoutCookiesClient } from '@/lib/supabase/signoutCleanup';
import { trackEvent } from '@/lib/analytics';
import { BILLING_ENABLED } from '@/lib/billing/constants';
import { canonicalAvatarState } from '@/lib/avatar';
import { avatarFallbackDataUrl, resolveDisplayName } from '@/lib/avatarFallback';
import styles from './Header.module.css';

const NAV_LINKS = [
  { label: 'Home', href: '/' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Download', href: '/download' },
  { label: 'Docs', href: '/docs' },
  { label: 'Marketplace', href: process.env.NEXT_PUBLIC_MARKETPLACE_URL || "https://marketplace.worldwideview.dev/" },
];

export default function Header({ initialUser = null }: { initialUser?: User | null }) {
  const pathname = usePathname();
  const router = useRouter();
  // activePath is always the current pathname -- derive it instead of copying
  // it into state via an effect.
  const activePath = pathname;
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [user, setUser] = useState<User | null>(initialUser);
  // Id of the user whose avatar failed to load. The fallback only applies to
  // this exact user id, so a different signed-in user automatically gets a
  // fresh avatar attempt without needing an effect to reset the flag.
  const [avatarErrorUserId, setAvatarErrorUserId] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const avatarState = canonicalAvatarState(user);
  // The browser only ever talks to the same-origin canonical endpoint
  // (`/api/avatar`); the server-side route proxies DiceBear or 307s to a
  // custom avatar_url, so this component never embeds an external avatar URL.
  const avatarSrc = user ? avatarState.canonicalUrl : null;
  // Resolved display name (display_name ?? name ?? full_name) drives the
  // initials fallback; the normalized email seed is the last resort. user.id
  // is never used as a seed.
  const resolvedDisplayName = user ? resolveDisplayName(user.user_metadata) : null;
  const avatarFallbackSeed = resolvedDisplayName ?? avatarState.seed;

  const closeDropdown = useCallback(() => {
    setDropdownOpen(false);
  }, []);

  // Close the dropdown whenever the route changes. Adjusting state during
  // render (instead of in an effect) lets React fold the reset into the same
  // render pass as the pathname change.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    setDropdownOpen(false);
  }

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
    // The browser-side signOut() only clears its own storage-key chunks
    // (`wwv-hub-auth-token` + chunks). Expire every chunk of BOTH session
    // cookie names (pinned hub name + legacy/marketplace default Supabase
    // name) so the shared .wwv.local jar does not accumulate stale cookies
    // and eventually trip HTTP 431.
    clearSignoutCookiesClient(resolveCookieDomain(process.env.NEXT_PUBLIC_WWV_COOKIE_DOMAIN));
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
                {avatarSrc && (
                  <img
                    src={
                      avatarErrorUserId === user.id
                        ? avatarFallbackDataUrl(avatarFallbackSeed)
                        : avatarSrc
                    }
                    alt=""
                    className={styles.avatarImg}
                    onError={() => setAvatarErrorUserId(user.id)}
                  />
                )}
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
                  <Link href="/accounts/redeem" className={styles.dropdownItem} role="menuitem" onClick={closeDropdown}>
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
              href="/accounts/redeem"
              className={`${styles.mobileLink} ${
                activePath === '/accounts/redeem' ? styles.mobileLinkActive : ''
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
          <Link
            href="/login"
            className={styles.mobileLink}
            onClick={() => setMenuOpen(false)}
          >
            Sign In
          </Link>
        )}
      </div>
    </header>
  );
}
