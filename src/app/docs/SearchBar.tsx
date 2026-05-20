'use client';

import { useState, useMemo, useRef, useCallback } from 'react';
import Fuse from 'fuse.js';
import Link from 'next/link';
import styles from './docs.module.css';

interface SearchIndexItem {
  slug: string;
  title: string;
  description: string;
  content: string;
}

interface Props {
  index: SearchIndexItem[];
  basePath: string;
}

export default function SearchBar({ index, basePath }: Props) {
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const fuse = useMemo(
    () =>
      new Fuse(index, {
        keys: [
          { name: 'title', weight: 2 },
          { name: 'description', weight: 1.5 },
          { name: 'content', weight: 0.8 },
        ],
        threshold: 0.35,
      }),
    [index]
  );

  const results = useMemo(
    () => (query.trim() ? fuse.search(query).slice(0, 6) : []),
    [fuse, query]
  );

  const close = useCallback(() => {
    setQuery('');
    setActiveIdx(-1);
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Escape') {
      close();
      inputRef.current?.blur();
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      window.location.href = `${basePath}/${results[activeIdx].item.slug}`;
      close();
    }
  }

  const listboxId = 'docs-search-listbox';

  return (
    <div className={styles.searchWrap}>
      <input
        ref={inputRef}
        type="search"
        placeholder="Search docs…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIdx(-1);
        }}
        onKeyDown={handleKeyDown}
        className={styles.searchInput}
        aria-label="Search documentation"
        aria-autocomplete="list"
        aria-controls={query ? listboxId : undefined}
        aria-activedescendant={activeIdx >= 0 ? `search-result-${activeIdx}` : undefined}
        autoComplete="off"
      />
      {query && (
        <ul id={listboxId} role="listbox" className={styles.searchDropdown}>
          {results.length === 0 ? (
            <li className={styles.searchNoResults}>No results for &ldquo;{query}&rdquo;</li>
          ) : (
            results.map(({ item }, i) => (
              <li
                key={item.slug}
                id={`search-result-${i}`}
                role="option"
                aria-selected={i === activeIdx}
                className={`${styles.searchResult} ${i === activeIdx ? styles.searchResultActive : ''}`}
              >
                <Link href={`${basePath}/${item.slug}`} onClick={close} tabIndex={-1}>
                  <span className={styles.searchResultTitle}>{item.title}</span>
                  {item.description && (
                    <span className={styles.searchResultDesc}>{item.description}</span>
                  )}
                </Link>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
