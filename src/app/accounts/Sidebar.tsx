"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserCircle, CreditCard, ExternalLink, Package } from "lucide-react";
import styles from "./sidebar.module.css";

const MARKETPLACE_URL = process.env.NEXT_PUBLIC_MARKETPLACE_URL ?? "https://marketplace.worldwideview.dev";

const NAV_ITEMS = [
    { label: "Overview", href: "/accounts", icon: UserCircle },
    { label: "Billing", href: "/accounts/billing", icon: CreditCard },
];

const MARKETPLACE_ITEMS = [
    { label: "Plugin Management", href: `${MARKETPLACE_URL}/account`, icon: Package },
];

export function Sidebar() {
    const pathname = usePathname();

    return (
        <aside className={styles.sidebar}>
            <div className={styles.sidebarInner}>
                <nav className={styles.navSection}>
                    <span className={styles.navLabel}>Account</span>
                    {NAV_ITEMS.map(({ label, href, icon: Icon }) => {
                        const active = pathname === href;
                        return (
                            <Link
                                key={href}
                                href={href}
                                className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}
                            >
                                <Icon size={18} className={styles.navIcon} />
                                <span>{label}</span>
                            </Link>
                        );
                    })}
                </nav>

                <div className={styles.navDivider} />

                <nav className={styles.navSection}>
                    <span className={styles.navLabel}>Marketplace</span>
                    {MARKETPLACE_ITEMS.map(({ label, href, icon: Icon }) => (
                        <a
                            key={href}
                            href={href}
                            className={styles.navItem}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            <Icon size={18} className={styles.navIcon} />
                            <span>{label}</span>
                            <ExternalLink size={12} className={styles.externalIcon} />
                        </a>
                    ))}
                </nav>
            </div>
        </aside>
    );
}
