import Link from "next/link";
import styles from "./Footer.module.css";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "/#features" },
      { label: "Pricing", href: "/pricing" },
      { label: "Download", href: "/download" },
      { label: "Plugins", href: "/plugins" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Documentation", href: "https://docs.worldwideview.dev" },
      { label: "Marketplace", href: "https://marketplace.worldwideview.dev" },
      { label: "Status", href: "https://status.worldwideview.dev" },
    ],
  },
  {
    title: "Community",
    links: [
      { label: "GitHub", href: "https://github.com/silvertakana/worldwideview" },
      { label: "Contributing", href: "https://github.com/silvertakana/worldwideview/blob/main/CONTRIBUTING.md" },
      { label: "Code of Conduct", href: "https://github.com/silvertakana/worldwideview/blob/main/CODE_OF_CONDUCT.md" },
    ],
  },
];

export default function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div className={styles.columns}>
          {COLUMNS.map((col) => (
            <div key={col.title} className={styles.column}>
              <h4 className={styles.columnTitle}>{col.title}</h4>
              <ul className={styles.list}>
                {col.links.map((link) => (
                  <li key={link.label}>
                    <Link href={link.href} className={styles.link}>
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className={styles.bottom}>
          <p className={styles.copyright}>
            © {new Date().getFullYear()} WorldWideView. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
