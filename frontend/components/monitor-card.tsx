"use client";

import { Bell, Lock, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { clsx } from "clsx";
import { formatDuration, timeAgo, type Monitor } from "@/lib/api";
import { useNow } from "@/lib/use-now";
import { Button, StatusBadge } from "./ui";

export function MonitorCard({
  monitor,
  canWrite,
  onOpen,
  onEdit,
  onTogglePause,
  onDelete,
}: {
  monitor: Monitor;
  canWrite: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onTogglePause: () => void;
  onDelete: () => void;
}) {
  const now = useNow();
  const host = (() => {
    try {
      return new URL(monitor.url).host;
    } catch {
      return monitor.url;
    }
  })();

  return (
    <article
      className={clsx(
        "group relative flex flex-col gap-4 rounded-2xl border bg-surface p-5 transition-shadow hover:shadow-lg",
        monitor.status === "DOWN" ? "border-down/50" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="flex items-center gap-2">
          <StatusBadge status={monitor.status} />
          {monitor.down_since && (
            <span className="text-xs text-down tabular-nums">for {formatDuration(now - monitor.down_since)}</span>
          )}
        </span>
        {!monitor.is_public && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted" title="Only you see this monitor">
            <Lock className="size-3" /> Private
          </span>
        )}
        {(monitor.has_webhook || monitor.has_telegram) && (
          <Bell
            className="size-4 text-muted"
            aria-label={[monitor.has_webhook && "Discord", monitor.has_telegram && "Telegram"].filter(Boolean).join(" and ") + " alerts on"}
          />
        )}
      </div>

      <button onClick={onOpen} className="text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-none">
        <h3 className="truncate text-base font-semibold">{monitor.name}</h3>
        <p className="truncate text-sm text-muted">{host}</p>
      </button>

      <dl className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs text-muted">Response</dt>
          <dd className="font-medium tabular-nums">
            {monitor.last_response_time_ms != null ? `${monitor.last_response_time_ms} ms` : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Uptime 24h</dt>
          <dd className="font-medium tabular-nums">{monitor.uptime_24h != null ? `${monitor.uptime_24h}%` : "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Checked</dt>
          <dd className="font-medium">{timeAgo(monitor.last_checked_at, now)}</dd>
        </div>
      </dl>

      {canWrite && (
        <div className="relative z-10 -mb-1 -mr-2 flex justify-end gap-1">
          <Button variant="ghost" className="h-8 px-2" onClick={onEdit} aria-label="Edit">
            <Pencil className="size-4" />
          </Button>
          <Button variant="ghost" className="h-8 px-2" onClick={onTogglePause} aria-label={monitor.status === "PAUSED" ? "Resume" : "Pause"}>
            {monitor.status === "PAUSED" ? <Play className="size-4" /> : <Pause className="size-4" />}
          </Button>
          <Button variant="danger" className="h-8 px-2" onClick={onDelete} aria-label="Delete">
            <Trash2 className="size-4" />
          </Button>
        </div>
      )}
    </article>
  );
}
