import Link from "next/link";
import { getSidebarItems } from "@/lib/docs";
import DocsSidebarNav from "./DocsSidebarNav";
import styles from "./docs.module.css";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const sidebarItems = getSidebarItems();

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarInner}>
          <Link href="/docs" className={styles.sidebarTitle}>
            Documentation
          </Link>
          <DocsSidebarNav items={sidebarItems} />
        </div>
      </aside>
      <main className={styles.content}>
        {children}
      </main>
    </div>
  );
}
