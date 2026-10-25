"use client";

import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BellRing, Wrench } from "lucide-react";
import { clsx } from "clsx";
import { inMaintenance } from "@pingward/shared";
import {
  api,
  formatDuration,
  timeAgo,
  type AlertChannel,
  type Incident,
  type Monitor,
  type Ping,
  type StatsPoint,
  type StatsRange,
  type TestAlertResult,
} from "@/lib/api";
import { useNow } from "@/lib/use-now";
import { Button, Modal, StatusBadge } from "./ui";

const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
const fmtDay = (ts: number) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const fmtDayHour = (ts: number) => new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit" });

type Range = "recent" | StatsRange;
const RANGES: { id: Range; label: string; uptimeLabel?: string }[] = [
  { id: "recent", label: "Recent" },
  { id: "24h", label: "24 h", uptimeLabel: "Uptime (24h)" },
  { id: "7d", label: "7 d", uptimeLabel: "Uptime (7 days)" },
  { id: "30d", label: "30 d", uptimeLabel: "Uptime (30 days)" },
];

/** One chart point for either source: single checks (Recent) or hourly averages. */
type Point = { t: number; ms: number | null; ok: number; checks: number; label: string };

const fromPings = (pings: Ping[]): Point[] =>
  pings.map((p) => ({
    t: p.created_at,
    ms: p.response_time_ms,
    ok: p.ok,
    checks: 1,
    label: `${p.ok ? "✓" : "✕"} ${p.status_code ?? "—"}${p.error ? ` · ${p.error}` : ""}`,
  }));

const fromStats = (stats: StatsPoint[]): Point[] =>
  stats.map((s) => ({ t: s.hour, ms: s.avg_ms, ok: s.ok, checks: s.checks, label: `${s.ok}/${s.checks} checks up` }));

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface-2 px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function PointTooltip({ active, payload, hourly }: { active?: boolean; payload?: { payload: Point }[]; hourly: boolean }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      <div className="text-muted">{hourly ? `${fmtDayHour(p.t)} (hour)` : new Date(p.t).toLocaleString("en-US")}</div>
      <div className="mt-1 font-semibold tabular-nums">{p.ms != null ? `${p.ms} ms${hourly ? " avg" : ""}` : "—"}</div>
      <div className={p.ok === p.checks ? "text-up" : "text-down"}>{p.label}</div>
    </div>
  );
}

const barClass = (p: Point) => (p.ok === p.checks ? "bg-up" : p.ok === 0 ? "bg-down" : "bg-pending");

const MAINTENANCE_OPTIONS = [
  { minutes: 60, label: "1 h" },
  { minutes: 4 * 60, label: "4 h" },
  { minutes: 24 * 60, label: "24 h" },
];

/** Start or end a maintenance window: no checks, alerts or downtime while it runs. */
function MaintenanceControl({ monitor, onChanged }: { monitor: Monitor; onChanged: () => void }) {
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const active = now > 0 && inMaintenance(monitor, now);
  async function set(minutes: number) {
    setBusy(true);
    try {
      await api.setMaintenance(monitor.id, minutes);
      onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Couldn't change maintenance");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="flex items-center gap-1.5 font-medium">
        <Wrench className="size-4 text-muted" /> Maintenance
      </span>
      {active && monitor.maintenance_until ? (
        <>
          <span className="text-muted">
            until {new Date(monitor.maintenance_until).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
          </span>
          <Button variant="outline" className="h-8" disabled={busy} onClick={() => set(0)}>
            End now
          </Button>
        </>
      ) : (
        <>
          <span className="text-muted">pause checks and alerts for</span>
          {MAINTENANCE_OPTIONS.map((o) => (
            <Button key={o.minutes} variant="outline" className="h-8" disabled={busy} onClick={() => set(o.minutes)}>
              {o.label}
            </Button>
          ))}
        </>
      )}
    </div>
  );
}

const CHANNEL_NAME: Record<AlertChannel, string> = { discord: "Discord", telegram: "Telegram" };

/** Sends a test message to every alert channel of the monitor and shows each outcome inline. */
function TestAlertButton({ id }: { id: number }) {
  const [state, setState] = useState<
    { kind: "idle" | "sending" } | { kind: "done"; results: TestAlertResult["results"] } | { kind: "error"; message: string }
  >({ kind: "idle" });
  async function send() {
    setState({ kind: "sending" });
    try {
      setState({ kind: "done", results: (await api.testAlert(id)).results });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : "Couldn't send the test alert" });
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button variant="outline" onClick={send} disabled={state.kind === "sending"}>
          <BellRing className="size-4" /> {state.kind === "sending" ? "Sending…" : "Send test alert"}
        </Button>
      </div>
      {state.kind === "done" && (
        <ul className="flex flex-col gap-1 text-sm">
          {state.results.map((r) => (
            <li key={r.channel} className={r.ok ? "text-up" : "text-down"}>
              {r.ok ? "✓" : "✕"} {CHANNEL_NAME[r.channel]}: {r.ok ? "sent, check the channel" : r.error}
            </li>
          ))}
        </ul>
      )}
      {state.kind === "error" && <span className="text-sm text-down">{state.message}</span>}
    </div>
  );
}

function IncidentList({ incidents }: { incidents: Incident[] }) {
  const now = useNow();
  if (incidents.length === 0) return <p className="text-sm text-muted">No incidents recorded. Nice.</p>;
  return (
    <ul className="divide-y divide-border rounded-xl border border-border text-sm">
      {incidents.map((i) => (
        <li key={i.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2">
          <span className="flex items-center gap-2">
            <span className={`size-2 rounded-full ${i.ended_at ? "bg-muted" : "bg-down"}`} aria-hidden />
            <span className="tabular-nums">{new Date(i.started_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</span>
            {i.cause && <span className="text-muted">· {i.cause}</span>}
          </span>
          <span className={i.ended_at ? "tabular-nums text-muted" : "font-medium text-down"}>
            {i.ended_at ? `down for ${formatDuration(i.ended_at - i.started_at)}` : `ongoing · ${formatDuration(now - i.started_at)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function MonitorDetail({
  monitor,
  canWrite,
  onClose,
  onChanged,
}: {
  monitor: Monitor | null;
  canWrite: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [range, setRange] = useState<Range>("recent");
  const [points, setPoints] = useState<{ range: Range; data: Point[] } | null>(null);
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  const id = monitor?.id;
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const series = () => (range === "recent" ? api.getPings(id, 50).then(fromPings) : api.getStats(id, range).then(fromStats));
    const load = () =>
      Promise.all([series(), api.getIncidents(id, 10)])
        .then(([data, inc]) => !cancelled && (setPoints({ range, data }), setIncidents(inc), setError(null)))
        .catch((e) => !cancelled && setError(e.message));
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [id, range]);

  // Shown only once the selected range has loaded, so a switch never flashes the old series.
  const data = points?.range === range ? points.data : null;
  const hourly = range !== "recent";
  const okPoints = data?.filter((p) => p.ms != null && p.ok > 0) ?? [];
  const okChecks = okPoints.reduce((s, p) => s + p.checks, 0);
  const avg = okChecks ? Math.round(okPoints.reduce((s, p) => s + (p.ms as number) * p.checks, 0) / okChecks) : null;
  const totalChecks = data?.reduce((s, p) => s + p.checks, 0) ?? 0;
  const totalOk = data?.reduce((s, p) => s + p.ok, 0) ?? 0;
  const uptimeLabel = RANGES.find((r) => r.id === range)?.uptimeLabel;
  const uptime = uptimeLabel
    ? totalChecks > 0
      ? `${Math.round((totalOk / totalChecks) * 10000) / 100}%`
      : "—"
    : monitor?.uptime_24h != null
      ? `${monitor.uptime_24h}%`
      : "—";
  const maintenance = now > 0 && monitor !== null && inMaintenance(monitor, now);

  return (
    <Modal
      open={!!monitor}
      onClose={onClose}
      wide
      title={
        monitor && (
          <span className="flex flex-col gap-1">
            <span className="flex items-center gap-3">
              {monitor.name} <StatusBadge status={monitor.status} maintenance={maintenance} />
            </span>
            <a href={monitor.url} target="_blank" rel="noreferrer" className="truncate text-sm font-normal text-muted hover:underline">
              {monitor.url}
            </a>
          </span>
        )
      }
    >
      {monitor && (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={uptimeLabel ?? "Uptime (24h)"} value={uptime} />
            <Stat label="Avg. response" value={avg != null ? `${avg} ms` : "—"} />
            <Stat label="Interval" value={`${monitor.interval_minutes} min`} />
            <Stat label="Last check" value={timeAgo(monitor.last_checked_at, now)} />
          </div>

          {(monitor.accepted_status || monitor.keyword) && (
            <p className="-mt-2 text-xs text-muted">
              UP means {monitor.accepted_status ? `status ${monitor.accepted_status}` : "any 2xx status"}
              {monitor.keyword && ` and the page contains “${monitor.keyword}”`}.
            </p>
          )}

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">
                {hourly ? "Average response time (ms) per hour" : `Response time (ms) · last ${data?.length ?? 0} checks`}
              </h3>
              <div role="tablist" aria-label="Chart range" className="flex rounded-lg bg-surface-2 p-0.5 text-xs">
                {RANGES.map((r) => (
                  <button
                    key={r.id}
                    role="tab"
                    aria-selected={range === r.id}
                    onClick={() => setRange(r.id)}
                    className={clsx(
                      "rounded-md px-2.5 py-1 font-medium transition-colors",
                      range === r.id ? "bg-surface text-foreground shadow-sm" : "text-muted hover:text-foreground",
                    )}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="h-64 rounded-xl border border-border p-2 pt-4">
              {error ? (
                <p className="p-4 text-sm text-down">{error}</p>
              ) : !data ? (
                <p className="p-4 text-sm text-muted">Loading…</p>
              ) : data.length === 0 ? (
                <p className="p-4 text-sm text-muted">No checks in this range yet. The cron runs every minute, so the first one is on its way.</p>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="t"
                      tickFormatter={range === "7d" || range === "30d" ? fmtDay : fmtTime}
                      tick={{ fill: "var(--muted)", fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      minTickGap={32}
                    />
                    <YAxis tick={{ fill: "var(--muted)", fontSize: 11 }} axisLine={false} tickLine={false} width={48} />
                    <Tooltip content={<PointTooltip hourly={hourly} />} cursor={{ stroke: "var(--muted)", strokeDasharray: "3 3" }} />
                    <Line
                      type="monotone"
                      dataKey="ms"
                      connectNulls
                      stroke="var(--accent)"
                      strokeWidth={2}
                      isAnimationActive={false}
                      dot={(props: { cx?: number; cy?: number; payload?: Point; index?: number }) =>
                        props.payload && props.payload.ok < props.payload.checks && props.cy != null ? (
                          <circle key={props.index} cx={props.cx} cy={props.cy} r={4} fill="var(--down)" stroke="var(--surface)" strokeWidth={2} />
                        ) : (
                          <g key={props.index} />
                        )
                      }
                      activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 2 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {data && data.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium">Status history{hourly && " (one bar per hour)"}</h3>
              <div
                className={clsx("flex h-8 items-stretch", data.length > 200 ? "gap-0" : "gap-[2px]")}
                role="img"
                aria-label={`${totalOk} of ${totalChecks} checks succeeded`}
              >
                {data.map((p) => (
                  <span
                    key={p.t}
                    title={`${hourly ? fmtDayHour(p.t) : new Date(p.t).toLocaleString("en-US")} · ${p.label}`}
                    className={clsx("min-w-px flex-1", data.length <= 200 && "rounded-[3px]", barClass(p))}
                  />
                ))}
              </div>
            </div>
          )}

          {incidents && (
            <div>
              <h3 className="mb-2 text-sm font-medium">Incidents</h3>
              <IncidentList incidents={incidents} />
            </div>
          )}

          {canWrite && monitor.status !== "PAUSED" && <MaintenanceControl monitor={monitor} onChanged={onChanged} />}

          {canWrite && (monitor.has_webhook || monitor.has_telegram) && <TestAlertButton id={monitor.id} />}
        </div>
      )}
    </Modal>
  );
}
