import Link from 'next/link';
import styles from './Footer.module.css';

const PRODUCT_LINKS = [
  { label: 'Features', href: '/#features' },
  { label: 'Cloud Instance', href: '/#cloud' },
  { label: 'Download', href: '/download' },
  { label: 'Pricing', href: '/pricing' },
];

const RESOURCE_LINKS = [
  { label: 'Documentation', href: '/docs' },
  { label: 'Marketplace', href: 'https://marketplace.worldwideview.dev/' },
  { label: 'Plugin SDK', href: '/docs/plugin-quickstart' },
  { label: 'Status', href: '/coming-soon' },
];

const COMMUNITY_LINKS = [
  { label: 'GitHub', href: 'https://github.com/silvertakana/worldwideview' },
  { label: 'Sponsor', href: '/sponsor' },
  { label: 'Contributing', href: 'https://github.com/silvertakana/worldwideview/blob/main/CONTRIBUTING.md' },
  { label: 'Code of Conduct', href: 'https://github.com/silvertakana/worldwideview/blob/main/CODE_OF_CONDUCT.md' },
];

const LEGAL_LINKS = [
  { label: 'Legal Hub', href: '/legal' },
  { label: 'Privacy Policy', href: '/legal/privacy-policy' },
  { label: 'Cloud ToS', href: '/legal/cloud-terms-of-service' },
  { label: 'Marketplace Terms', href: '/legal/marketplace-terms' },
];

export default function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.grid}>
        <div className={styles.brandCol}>
          <div className={styles.brandName}>WORLD WIDE VIEW</div>
          <p className={styles.brandDesc}>
            The standard for modern geospatial intelligence. Open-source
            core, enterprise-grade cloud.
          </p>
          <div className={styles.socialIcons}>
            <span className="material-symbols-outlined">language</span>
            <span className="material-symbols-outlined">terminal</span>
            <span className="material-symbols-outlined">share</span>
          </div>
        </div>

        <FooterColumn title="Product" links={PRODUCT_LINKS} />
        <FooterColumn title="Resources" links={RESOURCE_LINKS} />
        <FooterColumn title="Community" links={COMMUNITY_LINKS} />
        <FooterColumn title="Legal" links={LEGAL_LINKS} />
      </div>

      <div className={styles.bottomBar}>
        <div className={styles.copyright}>
          &copy; {new Date().getFullYear()} WORLD WIDE VIEW. All rights reserved.
        </div>
        <div className={styles.legalLinks}>
          <Link href="/legal/privacy-policy">Privacy Policy</Link>
          <Link href="/legal/cloud-terms-of-service">Terms of Service</Link>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: { label: string; href: string }[];
}) {
  return (
    <div className={styles.linksCol}>
      <h5>{title}</h5>
      <ul>
        {links.map(({ label, href }) => (
          <li key={label}>
            <Link href={href}>{label}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
