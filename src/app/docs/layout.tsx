import Link from "next/link";
import { getSidebarItems, getSearchIndex } from "@/lib/docs";
import DocsSidebarNav from "./DocsSidebarNav";
import SearchBar from "./SearchBar";
import ScrollToHash from "./ScrollToHash";
import styles from "./docs.module.css";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const isDocsSubdomain = process.env.NEXT_PUBLIC_IS_DOCS_SUBDOMAIN === 'true';
  const basePath = isDocsSubdomain ? '' : '/docs';
  const sidebarItems = getSidebarItems();
  const searchIndex = getSearchIndex();

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarInner}>
          <Link href={isDocsSubdomain ? '/' : '/docs'} className={styles.sidebarTitle}>
            Documentation
          </Link>
          <SearchBar index={searchIndex} basePath={basePath} />
          <DocsSidebarNav items={sidebarItems} basePath={basePath} />
        </div>
      </aside>
      <main className={styles.content}>
        <ScrollToHash />
        {children}
      </main>
    </div>
  );
}
