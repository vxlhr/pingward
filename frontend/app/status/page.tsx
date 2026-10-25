"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { ArrowLeft, CheckCircle2, CircleAlert, Wrench } from "lucide-react";
import { inMaintenance } from "@pingward/shared";
import { api, formatDuration, type StatusPage } from "@/lib/api";
import { useNow } from "@/lib/use-now";
import { LogoMark, Wordmark } from "@/components/logo";

const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_MS = 60_000;

type Row = StatusPage["monitors"][number];

const fmtDate = (ts: number) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Overall state for the banner: an outage outweighs maintenance, which outweighs "all good". */
function overall(monitors: Row[], now: number) {
  const down = monitors.filter((m) => m.status === "DOWN" && !inMaintenance(m, now)).length;
  if (down > 0) {
    return {
      cls: "border-down/40 bg-down-soft text-down",
      icon: <CircleAlert className="size-5" />,
      text: down === monitors.length ? "Major outage" : `${down} of ${monitors.length} services are down`,
    };
  }
  if (monitors.some((m) => inMaintenance(m, now))) {
    return { cls: "border-maintenance/40 bg-maintenance-soft text-maintenance", icon: <Wrench className="size-5" />, text: "Maintenance in progress" };
  }
  return { cls: "border-up/40 bg-up-soft text-up", icon: <CheckCircle2 className="size-5" />, text: "All systems operational" };
}

function statusText(m: Row, now: number) {
  if (inMaintenance(m, now)) return { text: "Maintenance", cls: "text-maintenance" };
  if (m.status === "DOWN") return { text: "Down", cls: "text-down" };
  if (m.status === "UP") return { text: "Operational", cls: "text-up" };
  if (m.status === "PAUSED") return { text: "Not monitored", cls: "text-muted" };
  return { text: "Checking…", cls: "text-pending" };
}

/** One bar per UTC day, oldest left. Days without checks stay grey. */
function DayBars({ row, days, now }: { row: Row; days: number; now: number }) {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const byDay = new Map(row.days.map((d) => [d.day, d]));
  const slots = Array.from({ length: days }, (_, i) => today - (days - 1 - i) * DAY_MS);
  return (
    <div className="flex h-8 items-stretch gap-[2px]" role="img" aria-label={`Daily uptime for the last ${days} days`}>
      {slots.map((day, i) => {
        const d = byDay.get(day);
        const ratio = d && d.checks > 0 ? d.ok / d.checks : null;
        return (
          <span
            key={day}
            title={`${fmtDate(day)} · ${ratio === null ? "no data" : `${Math.round(ratio * 10000) / 100}% up (${d!.ok}/${d!.checks} checks)`}`}
            className={clsx(
              "min-w-0 flex-1 rounded-[2px]",
              // Show fewer days on narrow screens: the oldest 60 drop out below sm.
              i < days - 30 && "hidden sm:block",
              ratio === null ? "bg-surface-2" : ratio === 1 ? "bg-up" : ratio >= 0.95 ? "bg-pending" : "bg-down",
            )}
          />
        );
      })}
    </div>
  );
}

export default function StatusPageView() {
  const [page, setPage] = useState<StatusPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  const load = useCallback(async () => {
    try {
      setPage(await api.getStatus());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the status");
    }
  }, []);

  useEffect(() => {
    // load() only sets state after the fetch resolves (asynchronously).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), REFRESH_MS);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const banner = page && page.monitors.length > 0 && now > 0 ? overall(page.monitors, now) : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <LogoMark className="size-10 shrink-0" />
          <h1 className="flex items-baseline gap-2 text-[1.6rem] leading-none">
            <Wordmark />
            <span className="text-base font-medium text-muted">Status</span>
          </h1>
        </div>
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground">
          <ArrowLeft className="size-4" /> Dashboard
        </Link>
      </header>

      {error && <div className="mb-6 rounded-xl border border-down/40 bg-down-soft px-4 py-3 text-sm text-down">{error}</div>}

      {!page && !error && (
        <div className="flex flex-col gap-4">
          <div className="h-16 animate-pulse rounded-2xl bg-surface-2" />
          <div className="h-64 animate-pulse rounded-2xl bg-surface-2" />
        </div>
      )}

      {page && page.monitors.length === 0 && (
        <p className="rounded-2xl border border-dashed border-border px-6 py-16 text-center text-sm text-muted">
          No public services yet.
        </p>
      )}

      {banner && (
        <div className={clsx("mb-6 flex items-center gap-3 rounded-2xl border px-5 py-4 text-lg font-semibold", banner.cls)}>
          {banner.icon}
          {banner.text}
        </div>
      )}

      {page && page.monitors.length > 0 && now > 0 && (
        <section className="divide-y divide-border rounded-2xl border border-border bg-surface">
          {page.monitors.map((m) => {
            const s = statusText(m, now);
            return (
              <div key={m.id} className="flex flex-col gap-2.5 px-5 py-4">
                <div className="flex items-center justify-between gap-4">
                  <span className="truncate font-medium">{m.name}</span>
                  <span className={clsx("shrink-0 text-sm font-medium", s.cls)}>{s.text}</span>
                </div>
                <DayBars row={m} days={page.days} now={now} />
                <div className="flex justify-between text-xs text-muted">
                  <span>
                    <span className="hidden sm:inline">{page.days} days ago</span>
                    <span className="sm:hidden">30 days ago</span>
                  </span>
                  <span className="tabular-nums">{m.uptime != null ? `${m.uptime}% uptime` : "No data yet"}</span>
                  <span>Today</span>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {page && page.monitors.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-base font-semibold">Recent incidents</h2>
          {page.incidents.length === 0 ? (
            <p className="text-sm text-muted">No incidents in the last 14 days.</p>
          ) : (
            <ul className="divide-y divide-border rounded-2xl border border-border bg-surface text-sm">
              {page.incidents.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={clsx("size-2 shrink-0 rounded-full", i.ended_at ? "bg-muted" : "bg-down")} aria-hidden />
                    <span className="font-medium">{i.monitor_name}</span>
                    <span className="text-muted tabular-nums">
                      {new Date(i.started_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
                    </span>
                  </span>
                  <span className={i.ended_at ? "tabular-nums text-muted" : "font-medium text-down"}>
                    {i.ended_at
                      ? `Resolved · down for ${formatDuration(i.ended_at - i.started_at)}`
                      : now > 0 && `Ongoing · ${formatDuration(now - i.started_at)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <footer className="mt-12 text-center text-xs text-muted">
        Checked every few minutes from the Cloudflare edge ·{" "}
        <a href="https://github.com/vxlhr/pingward" className="hover:text-foreground hover:underline">
          Powered by PingWard
        </a>
      </footer>
    </div>
  );
}
