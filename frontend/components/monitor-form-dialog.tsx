"use client";

import { useState, type FormEvent } from "react";
import { KEYWORD_MAX_LENGTH, loadOf, parseAcceptedStatus } from "@pingward/shared";
import { api, type Monitor, type MonitorEdit, type SettingsInfo } from "@/lib/api";
import { TelegramField } from "./telegram-field";
import { Button, Field, Input, Modal } from "./ui";

export type MonitorFormMode = { kind: "add" } | { kind: "edit"; monitor: Monitor };

/** Shortest interval (minutes) that fits in `room` spare checks per minute; null = nothing fits. */
function minIntervalFor(room: number) {
  return room > 1e-9 ? Math.max(1, Math.ceil(1 / room - 1e-9)) : null;
}

/** Add or edit a monitor. Mounted only while open, so the form always starts from fresh values. */
export function MonitorFormDialog({
  mode,
  capacity,
  telegramEnabled,
  onClose,
  onSaved,
}: {
  mode: MonitorFormMode;
  capacity: SettingsInfo | null;
  telegramEnabled: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = mode.kind === "edit" ? mode.monitor : null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeHook, setRemoveHook] = useState(false);
  const [chat, setChat] = useState("");
  const [removeChat, setRemoveChat] = useState(false);
  const [isPublic, setIsPublic] = useState(editing ? editing.is_public : true);

  // Spare capacity, counting this monitor's own share as free when editing an active one.
  const ownLoad = editing && editing.status !== "PAUSED" ? loadOf(editing.interval_minutes) : 0;
  const room = capacity
    ? Math.max(0, capacity.settings.checksPerMinute - capacity.usage.checksPerMinute + ownLoad)
    : null;
  const minInterval = room === null ? 1 : minIntervalFor(room);
  const intervalHint =
    room === null
      ? undefined
      : editing?.status === "PAUSED"
        ? "Paused monitors use no capacity. Resuming checks that the interval fits."
        : minInterval === null
          ? "Check capacity is full: pause a monitor or raise the capacity in Settings."
          : minInterval <= 1
            ? "Any interval fits in your remaining check capacity."
            : `Intervals of ${minInterval} minutes or more fit in your remaining check capacity.`;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const name = String(data.get("name")).trim();
    const url = String(data.get("url")).trim();
    const interval = Number(data.get("interval"));
    const hook = String(data.get("webhook") || "").trim();
    const acceptedStatus = String(data.get("accepted_status") || "").trim();
    const keyword = String(data.get("keyword") || "");
    if (acceptedStatus) {
      const parsed = parseAcceptedStatus(acceptedStatus);
      if (typeof parsed === "string") return setError(parsed.replace("accepted_status", "Accepted status codes"));
    }
    setBusy(true);
    setError(null);
    try {
      if (!editing) {
        await api.createMonitor({
          name,
          url,
          interval_minutes: interval,
          discord_webhook: hook || undefined,
          telegram_chat_id: chat.trim() || undefined,
          is_public: isPublic,
          accepted_status: acceptedStatus || undefined,
          keyword: keyword || undefined,
        });
      } else {
        // Send only what changed; alert destinations are never sent to the browser, so "unchanged" = left empty.
        const edit: MonitorEdit = {};
        if (name !== editing.name) edit.name = name;
        if (url !== editing.url) edit.url = url;
        if (interval !== editing.interval_minutes) edit.interval_minutes = interval;
        if (removeHook) edit.discord_webhook = null;
        else if (hook) edit.discord_webhook = hook;
        if (removeChat) edit.telegram_chat_id = null;
        else if (chat.trim()) edit.telegram_chat_id = chat.trim();
        if (isPublic !== editing.is_public) edit.is_public = isPublic;
        if (acceptedStatus !== (editing.accepted_status ?? "")) edit.accepted_status = acceptedStatus || null;
        if (keyword !== (editing.keyword ?? "")) edit.keyword = keyword || null;
        if (Object.keys(edit).length > 0) await api.editMonitor(editing.id, edit);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={editing ? `Edit ${editing.name}` : "New monitor"}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Name">
          <Input name="name" required maxLength={100} placeholder="Main website" defaultValue={editing?.name} autoFocus />
        </Field>
        <Field label="URL" hint={editing ? "Changing the URL restarts its status and closes an ongoing incident." : undefined}>
          <Input name="url" type="url" required placeholder="https://example.com" defaultValue={editing?.url} />
        </Field>
        <Field label="Check interval (minutes)" hint={intervalHint}>
          <Input
            name="interval"
            type="number"
            min={editing?.status === "PAUSED" ? 1 : (minInterval ?? 1)}
            max={1440}
            step={1}
            defaultValue={editing?.interval_minutes ?? Math.max(5, minInterval ?? 1)}
            required
          />
        </Field>
        <Field
          label={editing?.has_webhook ? "Discord webhook (one is set)" : "Discord webhook (optional)"}
          hint={
            editing?.has_webhook
              ? "Leave empty to keep the current webhook, or paste a new URL to replace it."
              : "Get notified when the site goes down and when it recovers."
          }
        >
          <Input name="webhook" type="url" placeholder="https://discord.com/api/webhooks/…" disabled={removeHook} />
        </Field>
        {editing?.has_webhook && (
          <label className="-mt-2 flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={removeHook} onChange={(e) => setRemoveHook(e.target.checked)} className="accent-[var(--accent)]" />
            Remove the webhook (stop Discord alerts)
          </label>
        )}
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
            className="mt-0.5 accent-[var(--accent)]"
          />
          <span>
            Show on the public dashboard
            <span className="block text-xs text-muted">
              Unchecked = private: still checked and alerting, but only visible after you sign in.
            </span>
          </span>
        </label>
        <TelegramField
          enabled={telegramEnabled}
          alreadySet={Boolean(editing?.has_telegram)}
          value={chat}
          onChange={setChat}
          remove={removeChat}
          onRemoveChange={setRemoveChat}
        />
        <details className="group rounded-lg border border-border px-3 py-2" open={Boolean(editing?.accepted_status || editing?.keyword)}>
          <summary className="cursor-pointer select-none text-sm font-medium">
            Advanced checks <span className="font-normal text-muted">(optional)</span>
          </summary>
          <div className="mt-3 flex flex-col gap-4 pb-1">
            <Field
              label="Accepted status codes"
              hint="Empty = any 2xx. Checked on the final response, after redirects."
            >
              <Input name="accepted_status" placeholder="200-299, 401" defaultValue={editing?.accepted_status ?? ""} />
            </Field>
            <Field label="Must contain" hint="Text that has to appear on the page (first 64 KB, case-sensitive).">
              <Input name="keyword" maxLength={KEYWORD_MAX_LENGTH} placeholder="Welcome" defaultValue={editing?.keyword ?? ""} />
            </Field>
          </div>
        </details>
        {error && <p className="rounded-lg bg-down-soft px-3 py-2 text-sm text-down">{error}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : editing ? "Save changes" : "Add monitor"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
