"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserCircle, CreditCard, ExternalLink, Package } from "lucide-react";
import styles from "./sidebar.module.css";

const MARKETPLACE_URL = process.env.NEXT_PUBLIC_MARKETPLACE_URL ?? "https://marketplace.worldwideview.dev";

const NAV_ITEMS = [
    { label: "Overview", href: "/accounts", icon: UserCircle },
    { label: "Billing", href: "/accounts/billing", icon: CreditCard },
    { label: "Plugin Management", href: `${MARKETPLACE_URL}/account`, icon: Package, external: true },
];

export function MobileNav() {
    const pathname = usePathname();

    return (
        <nav className={styles.mobileNav}>
            {NAV_ITEMS.map(({ label, href, icon: Icon, external }) => {
                const active = !external && pathname === href;
                const Comp = external ? "a" : Link;
                const extraProps = external ? { target: "_blank", rel: "noopener noreferrer" } : {};

                return (
                    <Comp
                        key={href}
                        href={href}
                        className={`${styles.mobileItem} ${active ? styles.mobileItemActive : ""}`}
                        {...extraProps}
                    >
                        <Icon size={16} />
                        <span>{label}</span>
                        {external && <ExternalLink size={12} className={styles.mobileExternalIcon} />}
                    </Comp>
                );
            })}
        </nav>
    );
}
