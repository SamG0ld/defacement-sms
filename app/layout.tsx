import type { Metadata } from "next";
import { Lato, Atkinson_Hyperlegible } from "next/font/google";
import "./globals.css";
import { ServiceWorkerRegistrar } from "./_components/ServiceWorkerRegistrar";

// DC34 "Agency" typography: Lato primary (UI/display), Atkinson Hyperlegible
// secondary (legibility). Both are Google Fonts; the theme layer references them
// via the --font-lato / --font-atkinson CSS variables.
const lato = Lato({
  variable: "--font-lato",
  subsets: ["latin"],
  weight: ["400", "700"],
});

// Secondary/legibility font, exposed as the --font-reading token. Kept to a
// single weight until it's applied to dense/field-facing text.
const atkinson = Atkinson_Hyperlegible({
  variable: "--font-atkinson",
  subsets: ["latin"],
  weight: ["400"],
});

export const metadata: Metadata = {
  title: "Defacement SMS",
  description: "DEF CON Defacement signage management system.",
  // Home-screen icon when the PWA is added on iOS (manifest icons cover Android).
  icons: { apple: "/apple-touch-icon.png" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${lato.variable} ${atkinson.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ServiceWorkerRegistrar />
        {children}
      </body>
    </html>
  );
}
