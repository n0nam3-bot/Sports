import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "NEONSLIP — Agent Cluster Betting Intelligence",
  description:
    "A hierarchy of AI agents that tear apart every slate: injuries, rest, matchups, market line value and graded self-improvement. Free-LLM powered.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen bg-[#03050b] text-[#d7e3f0] antialiased">
        {children}
      </body>
    </html>
  );
}
