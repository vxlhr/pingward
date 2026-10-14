"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Eye, KeyRound, Lock, Plus, RefreshCw, Settings as SettingsIcon } from "lucide-react";
import { api, ApiError, getToken, type HealthInfo, type Monitor, type SettingsInfo } from "@/lib/api";
import { Button } from "@/components/ui";
import { MonitorCard } from "@/components/monitor-card";
import { MonitorFormDialog, type MonitorFormMode } from "@/components/monitor-form-dialog";
import { MonitorDetail } from "@/components/monitor-detail";
import { TokenDialog } from "@/components/token-dialog";
import { SettingsDialog } from "@/components/settings-dialog";
import { CapacityMeter } from "@/components/capacity";
import { LogoMark, Wordmark } from "@/components/logo";

/** Data changes at most once a minute (cron), so polling faster only burns D1 reads. */
const REFRESH_MS = 60_000;

export default function Home() {
  const [monitors, setMonitors] = useState<Monitor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<MonitorFormMode | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [needsToken, setNeedsToken] = useState(false);
  const [settingsInfo, setSettingsInfo] = useState<SettingsInfo | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const load = useCallback(async () => {
    const token = Boolean(getToken());
    setHasToken(token);
    try {
      const h = await api.health().catch(() => null);
      if (h) setHealth(h);
      // Capacity and settings are admin-only (they'd reveal private monitors); visitors just get the list.
      const admin = token || h?.writeProtected === false;
      const [list, info] = await Promise.all([
        api.listMonitors(),
        admin ? api.getSettings().catch(() => null) : Promise.resolve(null),
      ]);
      setMonitors(list);
      setSettingsInfo(info);
      setError(null);
      setNeedsToken(false);
    } catch (e) {
      const unauthorized = e instanceof ApiError && e.status === 401;
      setNeedsToken(unauthorized);
      setError(unauthorized ? null : e instanceof Error ? e.message : "Could not reach the API");
    }
  }, []);

  useEffect(() => {
    // load() only sets state after the fetch resolves (asynchronously).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // Only poll while the tab is visible; catch up as soon as it becomes visible again.
    const t = setInterval(() => document.visibilityState === "visible" && load(), REFRESH_MS);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  async function mutate(fn: () => Promise<unknown>) {
    try {
      await fn();
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Action failed");
    }
  }

  const counts = {
    up: monitors?.filter((m) => m.status === "UP").length ?? 0,
    down: monitors?.filter((m) => m.status === "DOWN").length ?? 0,
    total: monitors?.length ?? 0,
  };
  const selected = monitors?.find((m) => m.id === selectedId) ?? null;
  // Until /api/health answers, assume writes are protected (hide actions rather than flash them).
  const canWrite = hasToken || health?.writeProtected === false;
  const maxMonitors = settingsInfo ? settingsInfo.limits[settingsInfo.settings.plan].maxMonitors : null;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <LogoMark className="size-11 shrink-0" />
          <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[1.75rem] leading-none">
            <Wordmark />
            {!canWrite && !needsToken && (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted">
                <Eye className="size-3" /> Read-only demo
              </span>
            )}
          </h1>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => load()} aria-label="Refresh">
            <RefreshCw className="size-4" />
          </Button>
          <Button variant="outline" onClick={() => setTokenOpen(true)}>
            <KeyRound className="size-4" /> <span className="hidden sm:inline">{hasToken ? "Token" : "Sign in"}</span>
          </Button>
          {canWrite && settingsInfo && (
            <Button variant="outline" onClick={() => setSettingsOpen(true)} aria-label="Settings">
              <SettingsIcon className="size-4" />
            </Button>
          )}
          {canWrite && (
            <Button onClick={() => setForm({ kind: "add" })}>
              <Plus className="size-4" /> Add monitor
            </Button>
          )}
        </div>
      </header>

      {monitors && monitors.length > 0 && !needsToken && (
        <div className="mb-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted">
          <span>
            <b className="text-foreground tabular-nums">{counts.total}</b>
            {maxMonitors !== null && <span className="tabular-nums"> / {maxMonitors}</span>} monitors
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-up" /> <b className="text-foreground tabular-nums">{counts.up}</b> up
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-down" /> <b className="text-foreground tabular-nums">{counts.down}</b> down
          </span>
          {settingsInfo && <CapacityMeter info={settingsInfo} className="sm:ml-auto" />}
        </div>
      )}

      {error && (
        <div className="mb-6 rounded-xl border border-down/40 bg-down-soft px-4 py-3 text-sm text-down">
          {error}. Is the Worker running? (<code className="font-mono">npm run dev:worker</code>)
        </div>
      )}

      {needsToken && (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border px-6 py-16 text-center">
          <Lock className="size-8 text-muted" />
          <div>
            <p className="font-medium">This dashboard is private</p>
            <p className="text-sm text-muted">Enter the API token to view the monitors.</p>
          </div>
          <Button onClick={() => setTokenOpen(true)}>
            <KeyRound className="size-4" /> Enter token
          </Button>
        </div>
      )}

      {!monitors && !error && !needsToken && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-48 animate-pulse rounded-2xl bg-surface-2" />
          ))}
        </div>
      )}

      {monitors?.length === 0 && (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border px-6 py-16 text-center">
          <Activity className="size-8 text-muted" />
          <div>
            <p className="font-medium">No monitors yet</p>
            <p className="text-sm text-muted">
              {canWrite
                ? "Add your first site and it will be checked from the Cloudflare edge on your schedule."
                : "Sign in with the API token to add sites."}
            </p>
          </div>
          {canWrite && (
            <Button onClick={() => setForm({ kind: "add" })}>
              <Plus className="size-4" /> Add monitor
            </Button>
          )}
        </div>
      )}

      {monitors && monitors.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {monitors.map((m) => (
            <MonitorCard
              key={m.id}
              monitor={m}
              canWrite={canWrite}
              onOpen={() => setSelectedId(m.id)}
              onEdit={() => setForm({ kind: "edit", monitor: m })}
              onTogglePause={() => mutate(() => api.setPaused(m.id, m.status !== "PAUSED"))}
              onDelete={() => confirm(`Delete "${m.name}"?`) && mutate(() => api.deleteMonitor(m.id))}
            />
          ))}
        </div>
      )}

      {form && <MonitorFormDialog mode={form} capacity={settingsInfo} telegramEnabled={Boolean(health?.telegramEnabled)} onClose={() => setForm(null)} onSaved={load} />}
      {settingsOpen && settingsInfo && (
        <SettingsDialog info={settingsInfo} onClose={() => setSettingsOpen(false)} onSaved={setSettingsInfo} />
      )}
      <TokenDialog open={tokenOpen} onClose={() => setTokenOpen(false)} onSaved={load} />
      {/* key: opening a different monitor starts the chart state fresh */}
      <MonitorDetail key={selectedId ?? "none"} monitor={selected} canWrite={canWrite} onClose={() => setSelectedId(null)} />
    </div>
  );
}
