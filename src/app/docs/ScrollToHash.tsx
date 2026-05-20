'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

function scrollToHash(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const top = window.scrollY + el.getBoundingClientRect().top - window.innerHeight * 0.25;
  window.scrollTo({ top, behavior: 'smooth' });
}

export default function ScrollToHash() {
  const pathname = usePathname();

  // Runs on every pathname change (cross-page navigation with a hash)
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    // Small delay so server-streamed page content finishes rendering
    const t = setTimeout(() => scrollToHash(hash), 80);
    return () => clearTimeout(t);
  }, [pathname]);

  // Handles same-page hash changes (e.g. user already on permissions page)
  useEffect(() => {
    function onHashChange() {
      const hash = window.location.hash.slice(1);
      if (hash) scrollToHash(hash);
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return null;
}
