"use client";

import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BellRing } from "lucide-react";
import { api, formatDuration, timeAgo, type AlertChannel, type Incident, type Monitor, type Ping, type TestAlertResult } from "@/lib/api";
import { useNow } from "@/lib/use-now";
import { Button, Modal, StatusBadge } from "./ui";

const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface-2 px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function PingTooltip({ active, payload }: { active?: boolean; payload?: { payload: Ping }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      <div className="text-muted">{new Date(p.created_at).toLocaleString("en-US")}</div>
      <div className="mt-1 font-semibold tabular-nums">{p.response_time_ms} ms</div>
      <div className={p.ok ? "text-up" : "text-down"}>
        {p.ok ? "✓" : "✕"} {p.status_code ?? "—"} {p.error && `· ${p.error}`}
      </div>
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

export function MonitorDetail({ monitor, canWrite, onClose }: { monitor: Monitor | null; canWrite: boolean; onClose: () => void }) {
  const [pings, setPings] = useState<Ping[] | null>(null);
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  const id = monitor?.id;
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const load = () =>
      Promise.all([api.getPings(id, 50), api.getIncidents(id, 10)])
        .then(([p, inc]) => !cancelled && (setPings(p), setIncidents(inc), setError(null)))
        .catch((e) => !cancelled && setError(e.message));
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [id]);

  const okPings = pings?.filter((p) => p.ok) ?? [];
  const avg = okPings.length ? Math.round(okPings.reduce((s, p) => s + p.response_time_ms, 0) / okPings.length) : null;

  return (
    <Modal
      open={!!monitor}
      onClose={onClose}
      wide
      title={
        monitor && (
          <span className="flex flex-col gap-1">
            <span className="flex items-center gap-3">
              {monitor.name} <StatusBadge status={monitor.status} />
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
            <Stat label="Uptime (24h)" value={monitor.uptime_24h != null ? `${monitor.uptime_24h}%` : "—"} />
            <Stat label="Avg. response" value={avg != null ? `${avg} ms` : "—"} />
            <Stat label="Interval" value={`${monitor.interval_minutes} min`} />
            <Stat label="Last check" value={timeAgo(monitor.last_checked_at, now)} />
          </div>

          <div>
            <h3 className="mb-2 text-sm font-medium">Response time (ms) · last {pings?.length ?? 0} checks</h3>
            <div className="h-64 rounded-xl border border-border p-2 pt-4">
              {error ? (
                <p className="p-4 text-sm text-down">{error}</p>
              ) : !pings ? (
                <p className="p-4 text-sm text-muted">Loading…</p>
              ) : pings.length === 0 ? (
                <p className="p-4 text-sm text-muted">No pings yet. The cron runs every minute, so the first check is on its way.</p>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={pings} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="created_at"
                      tickFormatter={fmtTime}
                      tick={{ fill: "var(--muted)", fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      minTickGap={32}
                    />
                    <YAxis tick={{ fill: "var(--muted)", fontSize: 11 }} axisLine={false} tickLine={false} width={48} />
                    <Tooltip content={<PingTooltip />} cursor={{ stroke: "var(--muted)", strokeDasharray: "3 3" }} />
                    <Line
                      type="monotone"
                      dataKey="response_time_ms"
                      stroke="var(--accent)"
                      strokeWidth={2}
                      isAnimationActive={false}
                      dot={(props: { cx?: number; cy?: number; payload?: Ping; index?: number }) =>
                        props.payload && !props.payload.ok ? (
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

          {pings && pings.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium">Status history</h3>
              <div className="flex h-8 items-stretch gap-[2px]" role="img" aria-label={`${okPings.length} of the last ${pings.length} checks succeeded`}>
                {pings.map((p) => (
                  <span
                    key={p.id}
                    title={`${new Date(p.created_at).toLocaleString("en-US")} · ${p.ok ? "UP" : "DOWN"} · ${p.response_time_ms} ms`}
                    className={`flex-1 rounded-[3px] ${p.ok ? "bg-up" : "bg-down"}`}
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

          {canWrite && (monitor.has_webhook || monitor.has_telegram) && <TestAlertButton id={monitor.id} />}
        </div>
      )}
    </Modal>
  );
}
