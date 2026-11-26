import type { Metadata } from "next";
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
  title: "Quillon — the enterprise AI platform",
  description:
    "Quillon is a self-hosted, Apache-2.0 enterprise AI platform on the Vercel AI SDK: streaming chat with Office file generation, agent tool loops, multi-agent workflows, structured output, a multi-language sandbox, embeddings, memory, skills, MCP, seven enterprise connectors and Entra ID SSO.",
  openGraph: {
    title: "Quillon — the enterprise AI platform",
    description:
      "Every capability an enterprise deploy needs: chat with document generation, agents, workflows, sandbox, connectors and Entra ID SSO — self-hosted in one deploy.",
    type: "website",
  },
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
