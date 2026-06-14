import type { Metadata, Viewport } from "next";
import { Lato, Atkinson_Hyperlegible, JetBrains_Mono } from "next/font/google";
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

export const metadata: Metadata = {
  title: "Defacement SMS",
  description: "Signage management system for a large hacking conference.",
  // Home-screen icon when the PWA is added on iOS (manifest icons cover Android).
  icons: { apple: "/apple-touch-icon.png" },
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
      </body>
    </html>
  );
}
