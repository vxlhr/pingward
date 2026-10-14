import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const description = "Serverless uptime monitoring on Cloudflare Workers + D1, with Discord alerts and a free-tier capacity model.";

export const metadata: Metadata = {
  // Link previews need absolute image URLs: set SITE_URL to the deployed address when building.
  metadataBase: new URL(process.env.SITE_URL ?? "http://localhost:8787"),
  title: "PingWard",
  description,
  openGraph: { title: "PingWard", description, type: "website", siteName: "PingWard" },
  twitter: { card: "summary_large_image", title: "PingWard", description },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
