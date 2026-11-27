import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import "./panels.css";
import "./ledger.css";

const sans = localFont({
  src: [
    { path: "../../public/fonts/plex-sans-400.woff2", weight: "400", style: "normal" },
    { path: "../../public/fonts/plex-sans-500.woff2", weight: "500", style: "normal" },
    { path: "../../public/fonts/plex-sans-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-ibm-plex-sans",
  display: "swap",
  fallback: ["Segoe UI", "system-ui", "sans-serif"],
});

const mono = localFont({
  src: [
    { path: "../../public/fonts/plex-mono-400.woff2", weight: "400", style: "normal" },
    { path: "../../public/fonts/plex-mono-500.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-ibm-plex-mono",
  display: "swap",
  fallback: ["ui-monospace", "Menlo", "monospace"],
});

export const metadata: Metadata = {
  title: "Quillon — enterprise AI workspace",
  description:
    "A focused AI workspace for cited answers, tool-using agents, workflows, local models, memory, skills and enterprise integrations.",
  openGraph: {
    title: "Quillon — enterprise AI workspace",
    description:
      "A focused workspace for cited chat, agents, workflows, local models and enterprise integrations.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b1117",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
