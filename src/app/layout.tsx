import type { Metadata, Viewport } from "next";
import type { CSSProperties, ReactNode } from "react";
import { Cormorant_Garamond, Inter } from "next/font/google";
import { palette, site } from "@/content/story";
import "./globals.css";

// Display serif with italics for the captions and headings.
const display = Cormorant_Garamond({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  display: "swap",
});

// Plain sans for the rail and small chrome.
const sans = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: site.pageTitle,
  description: site.description,
};

export const viewport: Viewport = {
  themeColor: palette.paper,
  width: "device-width",
  initialScale: 1,
};

/** The palette from story.ts as CSS custom properties, so CSS and code share one source. */
const tokens = Object.fromEntries(
  Object.entries(palette).map(([name, hex]) => [`--c-${name}`, hex]),
) as CSSProperties;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable}`} style={tokens}>
      <body>{children}</body>
    </html>
  );
}
