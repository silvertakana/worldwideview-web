import type { Metadata } from "next";
import Script from "next/script";
import ThemeProvider from "@/components/ThemeProvider";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import OutageBanner from "@/components/OutageBanner";
import { createClient } from "@/lib/supabase/server";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "WorldWideView | Real-Time Geospatial Intelligence",
    template: "%s | WorldWideView",
  },
  description:
    "Track aircraft, ships, and signals across the planet on an interactive 3D globe. Open source, plugin-driven, endlessly extensible.",
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

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <ThemeProvider>
          <OutageBanner />
          <Header initialUser={user} />
          <main style={{ flex: 1 }}>{children}</main>
          <Footer />
        </ThemeProvider>
        {process.env.NEXT_PUBLIC_ANALYTICS_SCRIPT_URL && (
          <Script defer src={process.env.NEXT_PUBLIC_ANALYTICS_SCRIPT_URL} data-website-id="b70ed34b-4361-490b-9a66-1e43bb74f4ec" strategy="afterInteractive" />
        )}
        <div id="kofi-container" style={{ position: "fixed", bottom: "20px", left: "20px", zIndex: 9999 }}></div>
        <Script src="https://storage.ko-fi.com/cdn/widget/Widget_2.js" strategy="lazyOnload" />
        <Script id="kofi-widget" strategy="lazyOnload">
          {`
            const checkKofi = setInterval(() => {
              if (typeof kofiwidget2 !== 'undefined') {
                clearInterval(checkKofi);
                kofiwidget2.init('Support me on Ko-fi', '#72a4f2', 'L3L11XDRUC');
                const container = document.getElementById('kofi-container');
                if (container) {
                  container.innerHTML = kofiwidget2.getHTML();
                }
              }
            }, 500);
          `}
        </Script>
      </body>
    </html>
  );
}
