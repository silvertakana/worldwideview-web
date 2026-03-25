import type { Metadata } from "next";
import ThemeProvider from "@/components/ThemeProvider";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "WorldWideView | Real-Time Geospatial Intelligence",
    template: "%s | WorldWideView",
  },
  description:
    "Track aircraft, ships, and signals across the planet on an interactive 3D globe. Open source, plugin-driven, endlessly extensible.",
  icons: { icon: "/favicon.ico" },
  openGraph: {
    title: "WorldWideView",
    description:
      "Real-time geospatial intelligence on a 3D globe. Open source and plugin-driven.",
    siteName: "WorldWideView",
    type: "website",
    locale: "en_US",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
        <script defer src="https://analytics.worldwideview.dev/script.js" data-website-id="b70ed34b-4361-490b-9a66-1e43bb74f4ec"></script>
      </head>
      <body style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <ThemeProvider>
          <Header />
          <main style={{ flex: 1 }}>{children}</main>
          <Footer />
        </ThemeProvider>
      </body>
    </html>
  );
}
