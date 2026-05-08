import fs from "fs";
import path from "path";
import matter from "gray-matter";
import Link from "next/link";
import { Metadata } from "next";
import styles from "./index.module.css";
import { FileText, ChevronRight } from "lucide-react";

export const metadata: Metadata = {
  title: "Legal Information",
  description: "Legal policies, agreements, and terms for WorldWideView.",
};

interface LegalDocument {
  slug: string;
  title: string;
  lastUpdated: string;
}

export default function LegalIndexPage() {
  const contentDir = path.join(process.cwd(), "content", "legal");
  
  let documents: LegalDocument[] = [];
  
  if (fs.existsSync(contentDir)) {
    const files = fs.readdirSync(contentDir);
    
    documents = files
      .filter((file) => file.endsWith(".md"))
      .map((file) => {
        const filePath = path.join(contentDir, file);
        const fileContent = fs.readFileSync(filePath, "utf-8");
        const { data } = matter(fileContent);
        
        return {
          slug: file.replace(".md", ""),
          title: data.title || file.replace(".md", ""),
          lastUpdated: data.lastUpdated || "N/A",
        };
      });
  }

  // Pre-defined order for importance
  const order = [
    "privacy-policy",
    "cloud-terms-of-service",
    "eula",
    "acceptable-use-policy",
    "data-accuracy-disclaimer",
    "developer-distribution-agreement",
    "marketplace-terms",
    "website-terms",
    "cookie-policy"
  ];

  // Sort documents by predefined order, then alphabetically
  documents.sort((a, b) => {
    const indexA = order.indexOf(a.slug);
    const indexB = order.indexOf(b.slug);
    
    if (indexA !== -1 && indexB !== -1) return indexA - indexB;
    if (indexA !== -1) return -1;
    if (indexB !== -1) return 1;
    
    return a.title.localeCompare(b.title);
  });

  return (
    <div className={styles.container}>
      <div className={styles.glowTL} />
      <div className={styles.glowBR} />
      
      <div className={styles.contentWrapper}>
        <header className={styles.header}>
          <h1 className={styles.title}>Legal Information</h1>
          <p className={styles.subtitle}>
            Policies, agreements, and terms governing your use of WorldWideView.
          </p>
        </header>

        <div className={styles.grid}>
          {documents.map((doc) => (
            <Link href={`/legal/${doc.slug}`} key={doc.slug} className={styles.card}>
              <div className={styles.cardIcon}>
                <FileText size={24} />
              </div>
              <div className={styles.cardContent}>
                <h2 className={styles.cardTitle}>{doc.title}</h2>
                <p className={styles.cardMeta}>
                  Last updated: {new Date(doc.lastUpdated).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                </p>
              </div>
              <div className={styles.cardAction}>
                <ChevronRight size={20} />
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
