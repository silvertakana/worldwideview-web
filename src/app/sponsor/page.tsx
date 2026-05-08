import React from "react";
import type { Metadata } from "next";
import styles from "./Sponsor.module.css";

export const metadata: Metadata = {
  title: "Sponsor",
  description: "Support the development of WorldWideView by becoming a sponsor.",
};

export default function SponsorPage() {
  return (
    <div className={styles.container}>
      <div className={styles.gradient} />
      
      <div className={styles.inner}>
        <h1 className={styles.heading}>Sponsor WorldWideView</h1>
        <p className={styles.description}>
          WorldWideView is completely open source and community-driven. 
          Your sponsorship helps fund server costs, dedicated development time, 
          and ensures the engine remains freely available for everyone.
        </p>

        <div className={styles.cardsGrid}>
          <div className={styles.card}>
            <div className={styles.githubContent}>
              <div className={styles.githubHeader}>
                <img 
                  src="https://avatars.githubusercontent.com/u/62156548?s=160&v=4" 
                  alt="silvertakana" 
                  className={styles.githubAvatar}
                />
                <h2>Sponsor Silver Phung on GitHub</h2>
              </div>
              <p>
                I'm Building WorldWideView: an open geospatial intelligence platform mapping real-world events in real time. I'm a solo founder focused on building something we all wish existed!
              </p>
              <a 
                href="https://github.com/sponsors/silvertakana" 
                target="_blank" 
                rel="noopener noreferrer"
                className={styles.githubButton}
              >
                <svg height="16" viewBox="0 0 16 16" width="16" fill="currentColor">
                  <path fillRule="evenodd" d="M4.25 2.5c-1.336 0-2.75 1.164-2.75 3 0 2.15 1.58 4.144 3.365 5.682A20.565 20.565 0 008 13.393a20.561 20.561 0 003.135-2.211C12.92 9.644 14.5 7.65 14.5 5.5c0-1.836-1.414-3-2.75-3-1.373 0-2.609.986-3.029 2.456a.75.75 0 01-1.442 0C6.859 3.486 5.623 2.5 4.25 2.5zM8 14.25l-.345.666-.002-.001-.006-.003-.018-.01a7.643 7.643 0 01-.31-.17 22.075 22.075 0 01-3.434-2.414C1.894 10.607 0 8.272 0 5.5 0 2.116 2.125 1 4.25 1 5.797 1 7.153 1.802 8 3.02 8.847 1.802 10.203 1 11.75 1 13.875 1 16 2.116 16 5.5c0 2.772-1.894 5.107-3.885 6.814a22.08 22.08 0 01-3.744 2.584l-.018.01-.006.003h-.002L8 14.25zm0 0l.345.666a.752.752 0 01-.69 0L8 14.25z"></path>
                </svg>
                Sponsor
              </a>
            </div>
          </div>
          
          <div className={styles.card}>
            <div className={styles.kofiContent}>
              <h2>One-Time Support</h2>
              <p>Prefer to make a one-time donation? You can buy me a coffee on Ko-fi!</p>
              <a 
                href="https://ko-fi.com/L3L11XDRUC" 
                target="_blank" 
                rel="noopener noreferrer"
                className={styles.kofiButton}
              >
                <img src="https://storage.ko-fi.com/cdn/cup-border.png" alt="Ko-fi" className={styles.kofiIcon} />
                Support me on Ko-fi
              </a>
            </div>
          </div>
        </div>

        <div className={styles.shoutoutSection}>
          <h2 className={styles.shoutoutHeading}>Our Sponsors</h2>
          <div className={styles.emptyState}>
            <span 
              className="material-symbols-outlined" 
              style={{ fontSize: "3rem", color: "var(--color-accent)", opacity: 0.8, marginBottom: "0.5rem" }}
            >
              workspace_premium
            </span>
            <h3>No sponsors yet</h3>
            <p style={{ marginBottom: "1.5rem" }}>You could be the very first! Support the project and see your name featured here.</p>
            <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", justifyContent: "center" }}>
              <a 
                href="https://ko-fi.com/L3L11XDRUC" 
                target="_blank" 
                rel="noopener noreferrer"
                className={styles.kofiButton}
                style={{ padding: "0.5rem 1rem", fontSize: "0.9rem" }}
              >
                <img src="https://storage.ko-fi.com/cdn/cup-border.png" alt="Ko-fi" className={styles.kofiIcon} />
                Ko-fi
              </a>
              <a 
                href="https://github.com/sponsors/silvertakana" 
                target="_blank" 
                rel="noopener noreferrer"
                className={styles.outlineBtn}
                style={{ padding: "0.5rem 1rem", fontSize: "0.9rem", display: "inline-flex", alignItems: "center", gap: "0.5rem", borderRadius: "999px", background: "rgba(255,255,255,0.1)", color: "#fff", textDecoration: "none", border: "1px solid rgba(255,255,255,0.2)" }}
              >
                <span>GitHub Sponsors</span>
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
