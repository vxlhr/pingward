import { useId } from "react";
import { clsx } from "clsx";

/** Shield outline (open on the left where the pulse enters) and the pulse line, in a 64×64 box. */
export const SHIELD_PATH = "M8.5 24V11Q20 9.5 32 4.5Q44 9.5 55.5 11V27Q55.5 48 32 59.5Q12.5 50 9.5 35";
export const PULSE_PATH = "M4 29.5H14L18 21.5L23.5 40L28 13.5L34 44L38 25.5L41.5 30.5H55";

export const BRAND = {
  shieldFrom: "#46cdec",
  shieldTo: "#1f7f9c",
  pulseFrom: "#4cf58c",
  pulseTo: "#16e6c9",
  ward: "#2ef0a0",
} as const;

/** The PingWard shield mark. Gradient ids are unique per instance so several logos can share a page. */
export function LogoMark({ className, title }: { className?: string; title?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  return (
    <svg viewBox="0 0 64 64" className={className} role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <defs>
        <linearGradient id={`s${id}`} x1="56" y1="6" x2="10" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={BRAND.shieldFrom} />
          <stop offset="1" stopColor={BRAND.shieldTo} />
        </linearGradient>
        <linearGradient id={`p${id}`} x1="4" y1="20" x2="55" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={BRAND.pulseFrom} />
          <stop offset="1" stopColor={BRAND.pulseTo} />
        </linearGradient>
      </defs>
      <path d={SHIELD_PATH} fill="none" stroke={`url(#s${id})`} strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d={PULSE_PATH} fill="none" stroke={`url(#p${id})`} strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** "Ping" in the text colour, "Ward" bold in brand green. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={clsx("tracking-tight", className)}>
      <span className="font-normal">Ping</span>
      <span className="font-bold text-brand">Ward</span>
    </span>
  );
}
