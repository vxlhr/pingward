import type { Metadata } from "next";
import type { ReactNode } from "react";

const description = "Live status and 90-day uptime of the services PingWard watches.";

export const metadata: Metadata = {
  title: "Status · PingWard",
  description,
  // Setting openGraph here replaces the inherited one, so point at the root preview image again.
  openGraph: { title: "Status · PingWard", description, type: "website", siteName: "PingWard", images: ["/opengraph-image"] },
  twitter: { card: "summary_large_image", title: "Status · PingWard", description, images: ["/opengraph-image"] },
};

export default function StatusLayout({ children }: { children: ReactNode }) {
  return children;
}
