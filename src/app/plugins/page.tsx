"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function PluginsPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/coming-soon");
  }, [router]);

  return (
    <div style={{ maxWidth: 600, margin: "0 auto", padding: "4rem 1.5rem", textAlign: "center" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>Redirecting…</h1>
      <p style={{ color: "var(--color-text-secondary)" }}>
        If you are not redirected,{" "}
        <a href="/coming-soon">click here</a>.
      </p>
    </div>
  );
}
