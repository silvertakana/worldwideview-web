'use client';

import { useState } from 'react';
import styles from './TerminalBlock.module.css';

interface TerminalBlockProps {
  code: string;
  title?: string;
}

export default function TerminalBlock({ code, title = 'terminal' }: TerminalBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={styles.terminal}>
      <div className={styles.titleBar}>
        <div className={styles.dots}>
          <span className={styles.dot} style={{ backgroundColor: '#ff5f57' }} />
          <span className={styles.dot} style={{ backgroundColor: '#febc2e' }} />
          <span className={styles.dot} style={{ backgroundColor: '#28c840' }} />
        </div>
        <span className={styles.titleText}>{title}</span>
        <button className={styles.copyBtn} onClick={handleCopy} aria-label="Copy to clipboard">
          <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
            {copied ? 'check' : 'content_copy'}
          </span>
          <span className={styles.copyLabel}>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre className={styles.codeArea}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
