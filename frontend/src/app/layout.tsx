import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

import AppShell from "@/components/layout/AppShell";

// Inter for the UI; JetBrains Mono for identifiers (PIIDs, CLINs, clause
// numbers) and audit timestamps. They fill the existing font variables, so
// every component switches without edits.
const inter = Inter({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://data-agent-ca.vercel.app";
const SITE_DESCRIPTION =
  "Source-grounded extraction for federal contracts. Every field is boxed on the source page, low-confidence values route to human review, and approved data exports Oracle-ready with a full audit trail.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Dataomatix — Federal contract extraction you can verify",
    template: "%s · Dataomatix",
  },
  description: SITE_DESCRIPTION,
  applicationName: "Dataomatix",
  keywords: [
    "federal contract extraction",
    "FAR DFARS clause extraction",
    "document intelligence",
    "source grounding",
    "human in the loop review",
    "SF 1449 extraction",
    "CLIN and ACRN funding lines",
    "Oracle Fusion export",
  ],
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Dataomatix",
    title: "Dataomatix — Federal contract extraction you can verify",
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "Dataomatix — Federal contract extraction you can verify",
    description: SITE_DESCRIPTION,
  },
  icons: {
    icon: "/dataomatix-logo.svg",
    apple: "/dataomatix-logo.svg",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="h-full overflow-hidden" suppressHydrationWarning>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
