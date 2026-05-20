'use client';

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./docs.module.css";

interface SidebarItem {
  slug: string;
  title: string;
}

export default function DocsSidebarNav({ items, basePath }: { items: SidebarItem[]; basePath: string }) {
  const pathname = usePathname();
  return (
    <nav>
      {items.map((item) => {
        const href = `${basePath}/${item.slug}`;
        const isActive = pathname === href || pathname === `/docs/${item.slug}`;
        return (
          <Link
            key={item.slug}
            href={href}
            className={`${styles.navLink} ${isActive ? styles.navLinkActive : ""}`}
          >
            {item.title}
          </Link>
        );
      })}
    </nav>
  );
}
