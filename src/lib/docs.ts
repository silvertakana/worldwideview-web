import fs from "fs";
import path from "path";
import matter from "gray-matter";

const DOCS_DIR = path.join(process.cwd(), "content", "docs");

export interface DocMeta {
  slug: string;
  title: string;
  description: string;
  order: number;
}

export interface DocPage {
  slug: string;
  title: string;
  content: string;
}

export function getAllDocSlugs(): string[] {
  if (!fs.existsSync(DOCS_DIR)) return [];
  return fs
    .readdirSync(DOCS_DIR)
    .filter((file) => file.endsWith(".md") && file !== "index.md")
    .map((file) => file.replace(".md", ""));
}

export function getDocBySlug(slug: string): DocPage | null {
  const filePath = path.join(DOCS_DIR, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;
  const { data, content } = matter(fs.readFileSync(filePath, "utf-8"));
  return { slug, title: data.title || slug, content };
}

export function getDocIndex(): DocPage | null {
  const filePath = path.join(DOCS_DIR, "index.md");
  if (!fs.existsSync(filePath)) return null;
  const { data, content } = matter(fs.readFileSync(filePath, "utf-8"));
  return { slug: "index", title: data.title || "Documentation", content };
}

export interface SearchIndexItem {
  slug: string;
  title: string;
  description: string;
  section: string;
}

function stripMarkdown(raw: string): string {
  return raw
    .replace(/```[a-zA-Z]*\n/g, '')
    .replace(/```/g, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[|].*[|]\s*$/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function getSearchIndex(): SearchIndexItem[] {
  if (!fs.existsSync(DOCS_DIR)) return [];
  const items: SearchIndexItem[] = [];
  for (const file of fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md'))) {
    const slug = file.replace('.md', '') === 'index' ? '' : file.replace('.md', '');
    const { data, content } = matter(fs.readFileSync(path.join(DOCS_DIR, file), 'utf-8'));
    const title = data.title || file.replace('.md', '');
    const description = data.description || '';
    for (const section of content.split(/\n(?=#{1,3} )/)) {
      const text = stripMarkdown(section);
      if (text.trim()) items.push({ slug, title, description, section: text });
    }
  }
  return items;
}

export function getSidebarItems(): DocMeta[] {
  if (!fs.existsSync(DOCS_DIR)) return [];
  return fs
    .readdirSync(DOCS_DIR)
    .filter((file) => file.endsWith(".md") && file !== "index.md")
    .map((file) => {
      const { data } = matter(fs.readFileSync(path.join(DOCS_DIR, file), "utf-8"));
      return {
        slug: file.replace(".md", ""),
        title: data.title || file.replace(".md", ""),
        description: data.description || "",
        order: typeof data.order === "number" ? data.order : 999,
      };
    })
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}
