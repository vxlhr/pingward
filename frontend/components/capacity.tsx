"use client";

import { clsx } from "clsx";
import type { SettingsInfo } from "@/lib/api";

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

/** "5.2 / 8 checks per minute" with a thin bar. */
export function CapacityMeter({ info, className }: { info: SettingsInfo; className?: string }) {
  const { checksPerMinute: used } = info.usage;
  const total = info.settings.checksPerMinute;
  const pct = Math.min(100, (used / total) * 100);
  return (
    <div className={clsx("flex items-center gap-2", className)} title="Average checks per minute your active monitors need">
      <span className="whitespace-nowrap">
        Capacity <b className="text-foreground tabular-nums">{fmt(used)}</b>
        <span className="tabular-nums"> / {total}</span> checks/min
      </span>
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-2" aria-hidden>
        <span
          className={clsx("block h-full rounded-full", pct >= 90 ? "bg-down" : pct >= 70 ? "bg-pending" : "bg-accent")}
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}

/** Plain-language examples of what a capacity buys. */
export function capacityExamples(checksPerMinute: number) {
  return `${checksPerMinute} sites every minute, ${checksPerMinute * 5} every 5 minutes, or any mix`;
}
