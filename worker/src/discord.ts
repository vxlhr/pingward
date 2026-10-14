import type { CheckResult } from './types';

const COLOR_DOWN = 0xef4444;
const COLOR_UP = 0x22c55e;

export function buildDiscordPayload(r: CheckResult) {
  const down = !r.ok;
  return {
    username: 'PingWard',
    embeds: [
      {
        title: down ? `🚨 Site down: ${r.monitor.name}` : `✅ Site back up: ${r.monitor.name}`,
        url: r.monitor.url,
        color: down ? COLOR_DOWN : COLOR_UP,
        fields: [
          { name: 'URL', value: r.monitor.url, inline: false },
          { name: 'Status code', value: r.statusCode?.toString() ?? '—', inline: true },
          { name: 'Response time', value: `${r.responseTimeMs} ms`, inline: true },
          ...(r.error ? [{ name: 'Error', value: r.error.slice(0, 1000), inline: false }] : []),
        ],
        footer: { text: 'PingWard • Cloudflare Workers' },
        timestamp: new Date(r.checkedAt).toISOString(),
      },
    ],
  };
}

/** The "Send test alert" message: proves the webhook works before a real outage does. */
export function buildTestPayload(monitor: { name: string; url: string }) {
  return {
    username: 'PingWard',
    embeds: [
      {
        title: `🔔 Test alert: ${monitor.name}`,
        url: monitor.url,
        color: 0x6d5dfc,
        description: 'This webhook is connected. You will be notified here when this site goes down and when it recovers.',
        fields: [{ name: 'URL', value: monitor.url, inline: false }],
        footer: { text: 'PingWard • Cloudflare Workers' },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/** POSTs a payload to a Discord webhook; resolves to the HTTP status (or throws on network error / timeout). */
export async function sendDiscord(webhook: string, payload: unknown): Promise<number> {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  });
  await res.body?.cancel();
  return res.status;
}
