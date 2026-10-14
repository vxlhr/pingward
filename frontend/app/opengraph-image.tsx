import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { BRAND, PULSE_PATH, SHIELD_PATH } from "@/components/logo";

/** The renderer only ships a regular weight; load Geist 400 + 700 (OFL, assets/fonts) so "Ward" is really bold. */
const font = (weight: 400 | 700) =>
  readFile(join(process.cwd(), "assets", "fonts", `geist-sans-latin-${weight}-normal.woff`));

// Link-preview card (Slack, Discord, LinkedIn, X…), rendered once at build time.
export const dynamic = "force-static";
export const alt = "PingWard: serverless uptime monitoring on Cloudflare Workers + D1";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#10131f";
const SURFACE = "#161a28";
const BORDER = "#2a3043";
const MUTED = "#8a93a8";

const cards = [
  { name: "api.example.com", status: "UP", color: "#22c55e", ms: "142 ms" },
  { name: "shop.example.com", status: "UP", color: "#22c55e", ms: "208 ms" },
  { name: "legacy.example.com", status: "DOWN", color: "#f05252", ms: "timeout" },
];

export default async function OpengraphImage() {
  const [regular, bold] = await Promise.all([font(400), font(700)]);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: BG,
          color: "#eef0f6",
          fontFamily: "Geist",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 32 }}>
          <svg width="132" height="132" viewBox="0 0 64 64">
            <defs>
              <linearGradient id="s" x1="56" y1="6" x2="10" y2="58" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor={BRAND.shieldFrom} />
                <stop offset="1" stopColor={BRAND.shieldTo} />
              </linearGradient>
              <linearGradient id="p" x1="4" y1="20" x2="55" y2="40" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor={BRAND.pulseFrom} />
                <stop offset="1" stopColor={BRAND.pulseTo} />
              </linearGradient>
            </defs>
            <path d={SHIELD_PATH} fill="none" stroke="url(#s)" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d={PULSE_PATH} fill="none" stroke="url(#p)" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div style={{ display: "flex", fontSize: 104, letterSpacing: -3 }}>
            <span style={{ fontWeight: 400 }}>Ping</span>
            <span style={{ fontWeight: 700, color: BRAND.ward }}>Ward</span>
          </div>
        </div>

        <div style={{ display: "flex", gap: 24 }}>
          {cards.map((c) => (
            <div
              key={c.name}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                gap: 14,
                padding: 28,
                borderRadius: 24,
                background: SURFACE,
                border: `2px solid ${c.status === "DOWN" ? "#5c2328" : BORDER}`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 24, fontWeight: 700, color: c.color }}>
                <div style={{ width: 14, height: 14, borderRadius: 7, background: c.color }} />
                {c.status}
              </div>
              <div style={{ fontSize: 26 }}>{c.name}</div>
              <div style={{ fontSize: 24, color: MUTED }}>{c.ms}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", fontSize: 28, color: MUTED }}>
          Serverless uptime monitoring · Cloudflare Workers · D1 · Discord alerts
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Geist", data: regular, weight: 400, style: "normal" },
        { name: "Geist", data: bold, weight: 700, style: "normal" },
      ],
    },
  );
}
