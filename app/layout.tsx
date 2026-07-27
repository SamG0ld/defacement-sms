import type { Metadata, Viewport } from "next";
import { Lato, Atkinson_Hyperlegible, JetBrains_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { ServiceWorkerRegistrar } from "./_components/ServiceWorkerRegistrar";

// DC34 "Agency" typography. Lato = UI/display (incl. the 900 wordmark in the
// shell); Atkinson Hyperlegible = dense/legibility text; JetBrains Mono = machine
// data ONLY (item IDs, counts, codes, telemetry). Each exposed as a CSS variable
// the theme layer references (--font-lato / --font-atkinson / --font-jetbrains).
const lato = Lato({
  variable: "--font-lato",
  subsets: ["latin"],
  weight: ["400", "700", "900"],
});

const atkinson = Atkinson_Hyperlegible({
  variable: "--font-atkinson",
  subsets: ["latin"],
  weight: ["400", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

// Shared so the browser-tab copy and the social/unfurl copy can't silently drift
// (each metadata sub-object owns its own fields — Next doesn't inherit them).
const SITE_DESCRIPTION = "Signage management system for a large hacking conference.";
const UNFURL_TITLE = "Defacement — Sign Management System";

export const metadata: Metadata = {
  // Absolute base for OG/Twitter image URLs — unfurlers reject relative paths.
  // The opengraph-image.png file convention (app/opengraph-image.png) is injected
  // automatically as og:image because openGraph below omits `images`; adding an
  // explicit images array here would override (suppress) that auto-injection.
  // Twitter reuses the same image via summary_large_image.
  metadataBase: new URL("https://app.example.com"),
  title: "Defacement SMS",
  description: SITE_DESCRIPTION,
  // Home-screen icon when the PWA is added on iOS (manifest icons cover Android).
  icons: { apple: "/apple-touch-icon.png" },
  openGraph: {
    type: "website",
    siteName: "Defacement",
    title: UNFURL_TITLE,
    description: SITE_DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: UNFURL_TITLE,
    description: SITE_DESCRIPTION,
  },
};

// viewport-fit=cover so env(safe-area-inset-*) is non-zero on notched devices —
// the mobile app shell pads its bottom tab bar and top clearance with the insets.
export const viewport: Viewport = {
  themeColor: "#0b1220",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${lato.variable} ${atkinson.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ServiceWorkerRegistrar />
        {children}
        {/* Vercel Web Analytics (client-side page views). The component injects its
            script via document.createElement + appendChild from our already-nonced
            bundle, so the strict `script-src 'nonce-… strict-dynamic'` CSP (lib/csp.ts)
            permits it through propagated trust — no CSP change needed. Script and beacon
            are both same-origin under /_vercel/insights/* (covered by connect-src 'self').
            Only collects on a Vercel deploy with Web Analytics toggled ON; a no-op locally. */}
        <Analytics />
      </body>
    </html>
  );
}
