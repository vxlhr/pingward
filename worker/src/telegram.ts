import type { TelegramInfo } from '@pingward/shared';
import type { CheckResult } from './types';

const API = 'https://api.telegram.org';

/** Numeric chat id (users are positive, groups/channels negative, e.g. -100…) or a public @channel. */
export const TELEGRAM_CHAT_ID = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

/** Bot tokens look like 123456789:AA… (digits, colon, 30+ url-safe chars). */
export const TELEGRAM_BOT_TOKEN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

/** The bot's own numeric ID is the part of the token before the colon. */
export const botIdFromToken = (token: string) => token.split(':')[0];

/** True when a chat ID points at the bot itself (bots can't message bots, so alerts would never arrive). */
export function isBotItself(chatId: string, token: string | undefined): boolean {
  const id = chatId.trim();
  if (token && id === botIdFromToken(token.trim())) return true;
  // Bot usernames always end in "bot"; a public channel named like that is vanishingly rare.
  return /^@\w*bot$/i.test(id);
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildTelegramMessage(r: CheckResult): string {
  const name = escapeHtml(r.monitor.name);
  const lines = [
    r.ok ? `✅ <b>Site back up: ${name}</b>` : `🚨 <b>Site down: ${name}</b>`,
    escapeHtml(r.monitor.url),
    '',
    `Status code: <code>${r.statusCode ?? '—'}</code>`,
    `Response time: <code>${r.responseTimeMs} ms</code>`,
  ];
  if (r.error) lines.push(`Error: <code>${escapeHtml(r.error.slice(0, 500))}</code>`);
  lines.push('', '<i>PingWard</i>');
  return lines.join('\n');
}

export function buildTelegramTest(monitor: { name: string; url: string }): string {
  return [
    `🔔 <b>Test alert: ${escapeHtml(monitor.name)}</b>`,
    escapeHtml(monitor.url),
    '',
    'This chat is connected. You will be notified here when this site goes down and when it recovers.',
    '',
    '<i>PingWard</i>',
  ].join('\n');
}

/** Turns Telegram's error description into something a person can act on. */
export function telegramErrorHint(status: number, description = ''): string {
  const d = description.toLowerCase();
  if (status === 401 || d.includes('unauthorized')) return 'The bot token is wrong. Set TELEGRAM_BOT_TOKEN again.';
  if (d.includes('chat not found')) {
    return 'Chat not found. Send any message to the bot first (or add it to the group), then check the chat ID.';
  }
  if (d.includes('blocked by the user')) return 'You blocked the bot. Unblock it in Telegram and try again.';
  if (d.includes("can't send messages to the bot") || d.includes("can't send messages to bots")) {
    return 'This chat ID is the bot itself. Use your own chat ID instead: message the bot, then use “Find my chat” (or ask @userinfobot for your ID).';
  }
  if (d.includes('not enough rights') || d.includes('not a member')) {
    return 'The bot is not allowed to post in this chat. Add it to the group or make it a channel admin.';
  }
  if (status === 429) return 'Telegram is rate limiting the bot. Try again in a minute.';
  return `Telegram rejected the message (HTTP ${status}${description ? `: ${description}` : ''}).`;
}

/** Sends one HTML message. Never throws: network errors come back as `ok: false`. */
export async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      await res.body?.cancel();
      return { ok: true };
    }
    const body = (await res.json().catch(() => null)) as { description?: string } | null;
    return { ok: false, error: telegramErrorHint(res.status, body?.description) };
  } catch {
    return { ok: false, error: "Couldn't reach Telegram. Try again in a moment." };
  }
}

type TgChat = { id: number; type: string; title?: string; username?: string; first_name?: string; last_name?: string };
type TgUpdate = Record<string, { chat?: TgChat } | undefined>;

/**
 * Bot identity plus the chats that recently wrote to it, so the dashboard can offer
 * "pick your chat" instead of asking people to dig a chat ID out of the Bot API.
 */
export async function getTelegramInfo(token: string | undefined): Promise<TelegramInfo> {
  if (!token) return { configured: false, chats: [] };
  if (!TELEGRAM_BOT_TOKEN.test(token)) return { configured: true, chats: [], error: 'TELEGRAM_BOT_TOKEN has an unexpected format.' };
  try {
    const signal = AbortSignal.timeout(5_000);
    const [meRes, updatesRes] = await Promise.all([
      fetch(`${API}/bot${token}/getMe`, { method: 'POST', signal }),
      // No offset: updates are only read, never confirmed. No allowed_updates either: Telegram
      // remembers that setting, so passing it would change what another app using this bot receives.
      // POST (not GET) so no cache between us and Telegram can serve a stale, empty update list.
      fetch(`${API}/bot${token}/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 100 }),
        signal,
      }),
    ]);
    const me = (await meRes.json().catch(() => null)) as { ok?: boolean; result?: { username: string; first_name: string }; description?: string } | null;
    if (!me?.ok || !me.result) return { configured: true, chats: [], error: telegramErrorHint(meRes.status, me?.description) };

    const updates = (await updatesRes.json().catch(() => null)) as { ok?: boolean; result?: TgUpdate[]; description?: string } | null;
    if (updatesRes.status === 409) {
      // A webhook (or another long-polling app) owns this bot's updates; we can still send, just not list chats.
      return {
        configured: true,
        bot: { username: me.result.username, name: me.result.first_name },
        chats: [],
        error: 'This bot is also used by another app (it has a webhook), so chats can’t be listed. Enter the chat ID by hand, or use a separate bot for PingWard.',
      };
    }
    const chats = new Map<string, { id: string; title: string; type: string }>();
    for (const u of updates?.ok ? (updates.result ?? []) : []) {
      for (const part of Object.values(u)) {
        const chat = typeof part === 'object' ? part?.chat : undefined;
        if (!chat) continue;
        const title =
          chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(' ') || (chat.username ? `@${chat.username}` : String(chat.id)));
        if (String(chat.id) === botIdFromToken(token)) continue;
        chats.set(String(chat.id), { id: String(chat.id), title, type: chat.type });
      }
    }
    return { configured: true, bot: { username: me.result.username, name: me.result.first_name }, chats: [...chats.values()].reverse() };
  } catch {
    return { configured: true, chats: [], error: "Couldn't reach Telegram. Try again in a moment." };
  }
}
