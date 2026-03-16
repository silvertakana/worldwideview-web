"use client";

import { useEffect } from "react";

export default function PluginsPage() {
  useEffect(() => {
    window.location.href = "https://marketplace.worldwideview.dev";
  }, []);

  return (
    <div style={{ maxWidth: 600, margin: "0 auto", padding: "4rem 1.5rem", textAlign: "center" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>Redirecting to Marketplace…</h1>
      <p style={{ color: "var(--color-text-secondary)" }}>
        If you are not redirected,{" "}
        <a href="https://marketplace.worldwideview.dev">click here</a>.
      </p>
    </div>
  );
}
