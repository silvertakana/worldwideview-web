'use client';

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./docs.module.css";

interface SidebarItem {
  slug: string;
  title: string;
}

export default function DocsSidebarNav({ items }: { items: SidebarItem[] }) {
  const pathname = usePathname();
  return (
    <nav>
      {items.map((item) => {
        const href = `/docs/${item.slug}`;
        return (
          <Link
            key={item.slug}
            href={href}
            className={`${styles.navLink} ${pathname === href ? styles.navLinkActive : ""}`}
          >
            {item.title}
          </Link>
        );
      })}
    </nav>
  );
}
