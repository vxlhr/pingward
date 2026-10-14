"use client";

import { useState, type FormEvent } from "react";
import { clsx } from "clsx";
import { RETENTION_RANGE, worstCaseSubrequests } from "@pingward/shared";
import { api, type Plan, type SettingsInfo, type TelegramInfo } from "@/lib/api";
import { CapacityMeter, capacityExamples } from "./capacity";
import { Button, Field, Input, Modal } from "./ui";

const PLAN_TEXT: Record<Plan, { title: string; body: string }> = {
  free: { title: "Cloudflare Free", body: "Stays inside the free Workers and D1 limits." },
  paid: { title: "Workers Paid", body: "For accounts on the $5/month plan with higher limits." },
};

/** Bot status, checked on demand (it asks Telegram, so not on every open). */
function TelegramStatus() {
  const [info, setInfo] = useState<TelegramInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function check() {
    setLoading(true);
    setError(null);
    try {
      setInfo(await api.getTelegram());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't check Telegram");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2.5 text-sm">
      <span className="text-muted">
        Telegram:{" "}
        {error ? (
          <span className="text-down">{error}</span>
        ) : !info ? (
          "not checked"
        ) : !info.configured ? (
          "not set up (add the TELEGRAM_BOT_TOKEN secret)"
        ) : info.error ? (
          <span className="text-down">{info.error}</span>
        ) : (
          <span className="text-up">connected as @{info.bot?.username}</span>
        )}
      </span>
      <Button type="button" variant="ghost" className="h-8" onClick={check} disabled={loading}>
        {loading ? "Checking…" : "Check"}
      </Button>
    </div>
  );
}

/** Remounted (via key) each time it opens, so the form starts from the saved values. */
export function SettingsDialog({
  info,
  onClose,
  onSaved,
}: {
  info: SettingsInfo;
  onClose: () => void;
  onSaved: (info: SettingsInfo) => void;
}) {
  const [plan, setPlan] = useState<Plan>(info.settings.plan);
  const [checks, setChecks] = useState(String(info.settings.checksPerMinute));
  const [retention, setRetention] = useState(String(info.settings.pingRetentionDays));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const max = info.limits[plan].maxChecksPerMinute;
  const checksNum = Number(checks);

  function choosePlan(next: Plan) {
    setPlan(next);
    // Keep the number valid for the chosen plan.
    if (Number(checks) > info.limits[next].maxChecksPerMinute) setChecks(String(info.limits[next].maxChecksPerMinute));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.updateSettings({ plan, checksPerMinute: checksNum, pingRetentionDays: Number(retention) }));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save settings");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Settings">
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-sm font-medium">Cloudflare plan</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(Object.keys(PLAN_TEXT) as Plan[]).map((p) => (
              <label
                key={p}
                className={clsx(
                  "flex cursor-pointer flex-col gap-0.5 rounded-xl border p-3 text-sm transition-colors",
                  plan === p ? "border-accent bg-surface-2" : "border-border hover:bg-surface-2",
                )}
              >
                <span className="flex items-center gap-2 font-medium">
                  <input type="radio" name="plan" value={p} checked={plan === p} onChange={() => choosePlan(p)} className="accent-[var(--accent)]" />
                  {PLAN_TEXT[p].title}
                </span>
                <span className="text-xs text-muted">{PLAN_TEXT[p].body}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <Field
          label={`Check capacity (checks per minute, max ${max})`}
          hint={Number.isInteger(checksNum) && checksNum > 0 ? `That's ${capacityExamples(checksNum)}.` : undefined}
        >
          <Input type="number" min={1} max={max} step={1} value={checks} onChange={(e) => setChecks(e.target.value)} required />
        </Field>

        <Field
          label="Keep raw ping history (days)"
          hint="Used for the latency chart. Uptime percentages come from hourly totals kept for 30 days."
        >
          <Input
            type="number"
            min={RETENTION_RANGE.min}
            max={RETENTION_RANGE.max}
            step={1}
            value={retention}
            onChange={(e) => setRetention(e.target.value)}
            required
          />
        </Field>

        <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted">
          <CapacityMeter info={info} />
          <p className="mt-1 text-xs">
            {info.usage.monitors} monitors now, {info.limits[plan].maxMonitors} allowed on this plan.
          </p>
          {Number.isInteger(checksNum) && checksNum > 0 && (
            <p className="mt-1 text-xs">
              Worst case per cron run: <b className="tabular-nums text-foreground">{worstCaseSubrequests(checksNum)}</b> of{" "}
              {info.limits[plan].subrequestsPerRun} subrequests (every site redirecting 3 times, all alerting on Discord and
              Telegram at once).
            </p>
          )}
        </div>

        <TelegramStatus />

        {error && <p className="rounded-lg bg-down-soft px-3 py-2 text-sm text-down">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save settings"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
