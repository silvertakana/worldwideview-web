import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getDocIndex } from "@/lib/docs";
import type { Metadata } from "next";
import styles from "./docs.module.css";

export const metadata: Metadata = {
  title: "Documentation",
  description: "WorldWideView developer documentation.",
};

export default function DocsIndexPage() {
  const doc = getDocIndex();

  if (!doc) {
    return (
      <article className={styles.prose}>
        <h1>Documentation</h1>
        <p>Coming soon.</p>
      </article>
    );
  }

  return (
    <article className={styles.prose}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.content}</ReactMarkdown>
    </article>
  );
}
