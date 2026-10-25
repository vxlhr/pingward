import { CONFIRM_FAILURES, type AlertChannel } from '@pingward/shared';
import type { CheckResult, Env, Monitor, MonitorStatus } from './types';
import { buildDiscordPayload, sendDiscord } from './discord';
import { TELEGRAM_BOT_TOKEN, buildTelegramMessage, sendTelegram } from './telegram';

/**
 * Counts subrequests (fetches, D1 calls) in one invocation so we never ask for more than the
 * plan allows. The settings ceilings already make the worst case fit; this is the second lock.
 */
export class SubrequestBudget {
  private used = 0;
  constructor(readonly limit: number) {}
  spend(n = 1) {
    this.used += n;
  }
  /** Reserve-and-check in one step: true if `n` more subrequests still fit. */
  take(n = 1): boolean {
    if (this.used + n > this.limit) return false;
    this.used += n;
    return true;
  }
  get remaining() {
    return this.limit - this.used;
  }
  get spent() {
    return this.used;
  }
}

/**
 * Status after a check. One success is enough to be UP; a failure only turns the monitor DOWN
 * once it has failed CONFIRM_FAILURES times in a row (until then it keeps its status).
 */
export function nextState(
  m: Pick<Monitor, 'status' | 'fail_streak'>,
  ok: boolean,
): { status: MonitorStatus; failStreak: number } {
  if (ok) return { status: 'UP', failStreak: 0 };
  const failStreak = m.fail_streak + 1;
  if (m.status === 'DOWN' || failStreak >= CONFIRM_FAILURES) return { status: 'DOWN', failStreak };
  return { status: m.status, failStreak };
}

/** Should this result notify? UP↔DOWN changes, and the first check only when it's an outage. */
export function isAlertWorthy(r: CheckResult): boolean {
  const prev = r.monitor.status;
  const next = nextState(r.monitor, r.ok).status;
  if (prev === next) return false;
  if (prev === 'PENDING') return next === 'DOWN';
  return true;
}

interface Alert {
  channel: AlertChannel;
  result: CheckResult;
  send: () => Promise<boolean>;
}

/** The alerts a set of results would send, outages first (they matter most if the budget is tight). */
export function planAlerts(env: Env, results: CheckResult[]): Alert[] {
  // A malformed token can never work: don't spend subrequests on it every minute.
  const raw = env.TELEGRAM_BOT_TOKEN?.trim();
  const token = raw && TELEGRAM_BOT_TOKEN.test(raw) ? raw : undefined;
  const alerts: Alert[] = [];
  for (const r of results.filter(isAlertWorthy)) {
    const { discord_webhook: hook, telegram_chat_id: chat } = r.monitor;
    if (hook) {
      alerts.push({
        channel: 'discord',
        result: r,
        send: () =>
          sendDiscord(hook, buildDiscordPayload(r)).then(
            (status) => status < 300,
            () => false,
          ),
      });
    }
    if (chat && token) {
      alerts.push({
        channel: 'telegram',
        result: r,
        send: () => sendTelegram(token, chat, buildTelegramMessage(r)).then((x) => x.ok),
      });
    }
  }
  return alerts.sort((a, b) => Number(a.result.ok) - Number(b.result.ok));
}

/** Sends planned alerts while the budget allows; anything that doesn't fit is logged, never sent. */
export async function sendAlerts(alerts: Alert[], budget: SubrequestBudget) {
  const allowed = alerts.filter(() => budget.take());
  const skipped = alerts.length - allowed.length;
  if (skipped > 0) console.warn(`PingWard: skipped ${skipped} alert(s) to stay within ${budget.limit} subrequests`);
  const outcomes = await Promise.all(allowed.map((a) => a.send()));
  outcomes.forEach((ok, i) => {
    if (!ok) console.warn(`PingWard: ${allowed[i].channel} alert failed (monitor ${allowed[i].result.monitor.id})`);
  });
  return { sent: outcomes.filter(Boolean).length, failed: outcomes.filter((ok) => !ok).length, skipped };
}
