import Link from "next/link";
import { headers } from "next/headers";
import { getSidebarItems } from "@/lib/docs";
import DocsSidebarNav from "./DocsSidebarNav";
import styles from "./docs.module.css";

export default async function DocsLayout({ children }: { children: React.ReactNode }) {
  const headersList = await headers();
  const host = headersList.get('host') ?? '';
  const isDocsSubdomain = host.startsWith('docs.');
  const basePath = isDocsSubdomain ? '' : '/docs';
  const sidebarItems = getSidebarItems();

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarInner}>
          <Link href={isDocsSubdomain ? '/' : '/docs'} className={styles.sidebarTitle}>
            Documentation
          </Link>
          <DocsSidebarNav items={sidebarItems} basePath={basePath} />
        </div>
      </aside>
      <main className={styles.content}>
        {children}
      </main>
    </div>
  );
}
