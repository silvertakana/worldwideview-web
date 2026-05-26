"use client";

import { useState, FormEvent } from "react";
import { trackEvent } from "@/lib/analytics";
import styles from "./page.module.css";

const WEBHOOK_URL =
  "https://n8n.arfquant.com/webhook/worldwideview-waitlist";

export default function WaitlistPage() {
  const [firstName, setFirstName] = useState("");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;

    setStatus("loading");
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstName: firstName.trim(), email: email.trim() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus("success");
      trackEvent("waitlist_signup", {});
      setFirstName("");
      setEmail("");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Join the waitlist</h1>
      <p className={styles.sub}>
        Be the first to access WorldWideView Cloud, a fully managed,
        always-on geospatial intelligence platform. Enter your email and
        we&apos;ll notify you when it&apos;s ready.
      </p>

      {status === "success" ? (
        <div className={styles.successCard}>
          <span className={styles.successIcon}>✓</span>
          <p className={styles.successText}>
            You&apos;re on the list! We&apos;ll be in touch soon.
          </p>
        </div>
      ) : (
        <form className={styles.form} onSubmit={handleSubmit}>
          <div className={styles.fields}>
            <input
              type="text"
              required
              name="firstName"
              autoComplete="given-name"
              placeholder="First name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className={styles.input}
              disabled={status === "loading"}
            />
            <input
              type="email"
              required
              name="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={styles.input}
              disabled={status === "loading"}
            />
          </div>
          <button
            type="submit"
            className={styles.submitBtn}
            disabled={status === "loading"}
          >
            {status === "loading" ? "Submitting…" : "Join Waitlist"}
          </button>
        </form>
      )}

      {status === "error" && (
        <p className={styles.errorText}>
          Something went wrong. Please try again.
        </p>
      )}
    </div>
  );
}
