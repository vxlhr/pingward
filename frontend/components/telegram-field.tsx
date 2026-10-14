"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { api, type TelegramInfo } from "@/lib/api";
import { Button, Field, Input } from "./ui";

/**
 * Telegram chat ID input with a "Find my chat" helper: lists the chats that recently messaged
 * the bot, so nobody has to dig an ID out of the Bot API by hand.
 */
export function TelegramField({
  enabled,
  alreadySet,
  value,
  onChange,
  remove,
  onRemoveChange,
}: {
  /** TELEGRAM_BOT_TOKEN is configured on the Worker. */
  enabled: boolean;
  /** Editing a monitor that already has a chat (the ID itself is never sent to the browser). */
  alreadySet: boolean;
  value: string;
  onChange: (v: string) => void;
  remove: boolean;
  onRemoveChange: (v: boolean) => void;
}) {
  const [info, setInfo] = useState<TelegramInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  async function findChats() {
    setLoading(true);
    setLookupError(null);
    try {
      setInfo(await api.getTelegram());
    } catch (e) {
      setLookupError(e instanceof Error ? e.message : "Couldn't ask Telegram");
    } finally {
      setLoading(false);
    }
  }

  const hint = !enabled
    ? "Telegram isn't set up on this server yet: add the TELEGRAM_BOT_TOKEN secret (see the README)."
    : alreadySet
      ? "Leave empty to keep the current chat, or enter a new chat ID to replace it."
      : "Your user, group or channel chat ID. Use “Find my chat” after messaging the bot.";

  return (
    <div className="flex flex-col gap-2">
      <Field label={alreadySet ? "Telegram chat (one is set)" : "Telegram chat ID (optional)"} hint={hint}>
        <div className="flex gap-2">
          <Input
            name="telegram"
            inputMode="text"
            placeholder="123456789 or @channelname"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={remove}
            autoComplete="off"
          />
          {enabled && (
            <Button type="button" variant="outline" className="h-10 shrink-0" onClick={findChats} disabled={loading || remove}>
              <Search className="size-4" /> {loading ? "Looking…" : "Find my chat"}
            </Button>
          )}
        </div>
      </Field>

      {lookupError && <p className="text-sm text-down">{lookupError}</p>}
      {info?.error && <p className="text-sm text-down">{info.error}</p>}
      {info && !info.error && info.chats.length === 0 && (
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">
          No chats yet. Open{" "}
          {info.bot ? (
            <a className="text-brand underline" href={`https://t.me/${info.bot.username}`} target="_blank" rel="noreferrer">
              @{info.bot.username}
            </a>
          ) : (
            "your bot"
          )}{" "}
          in Telegram and press <b>Start</b> (or add the bot to your group and send a message), then try again.
        </p>
      )}
      {info && info.chats.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border text-sm">
          {info.chats.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onChange(c.id)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-surface-2"
              >
                <span className="truncate">
                  {c.title} <span className="text-muted">· {c.type}</span>
                </span>
                <code className="shrink-0 text-xs text-muted">{c.id}</code>
              </button>
            </li>
          ))}
        </ul>
      )}

      {alreadySet && (
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={remove} onChange={(e) => onRemoveChange(e.target.checked)} className="accent-[var(--accent)]" />
          Remove the Telegram chat (stop Telegram alerts)
        </label>
      )}
    </div>
  );
}
