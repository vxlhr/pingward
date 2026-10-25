import {
  D1_CALLS_PER_RUN,
  KEYWORD_SCAN_BYTES,
  MAX_REDIRECTS,
  PLAN_LIMITS,
  inMaintenance,
  isAccepted,
  parseAcceptedStatus,
} from '@pingward/shared';
import type { CheckResult, Env, Monitor } from './types';
import { SubrequestBudget, nextState, planAlerts, sendAlerts } from './alerts';
import { SELECT_SETTINGS_SQL, settingsFromRows } from './settings';
import { checkTargetUrl } from './validation';

export { MAX_REDIRECTS };

const REQUEST_TIMEOUT_MS = 10_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const STATS_RETENTION_MS = 30 * DAY_MS;
const INCIDENT_RETENTION_MS = 90 * DAY_MS;
/** The status page shows 90 daily bars. */
const DAILY_STATS_RETENTION_MS = 90 * DAY_MS;

/** Failed once but not DOWN yet: re-checked after a minute to confirm or clear the failure. */
const isSuspect = (m: Monitor) => m.fail_streak > 0 && m.status !== 'DOWN';

/**
 * Returns up to `limit` monitors that are due (or never checked). Monitors waiting to confirm
 * a failure go first, then the longest-waiting. Paused and in-maintenance monitors are skipped.
 */
export function selectDueMonitors(monitors: Monitor[], now: number, limit: number): Monitor[] {
  return monitors
    .filter((m) => m.status !== 'PAUSED' && !inMaintenance(m, now))
    .filter((m) => {
      if (m.last_checked_at === null) return true;
      const wait = isSuspect(m) ? 1 : m.interval_minutes;
      return now - m.last_checked_at >= wait * 60_000 - 5_000;
    })
    .sort((a, b) => Number(isSuspect(b)) - Number(isSuspect(a)) || (a.last_checked_at ?? 0) - (b.last_checked_at ?? 0))
    .slice(0, limit);
}

/** Reads at most `max` bytes of a body as text, then releases the connection. */
async function readHead(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const bytes = new Uint8Array(max);
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    const part = value.subarray(0, max - size);
    bytes.set(part, size);
    size += part.byteLength;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(bytes.subarray(0, size));
}

/**
 * GETs the monitor URL, following redirects by hand so every hop is re-validated
 * (a public URL must not be able to bounce the check to a private address).
 * Every hop is one subrequest, taken from `budget`. The final response is UP when its status is
 * accepted (any 2xx by default) and, if a keyword is set, the first 64 KB of the body contain it.
 */
export async function checkMonitor(monitor: Monitor, budget = new SubrequestBudget(Infinity)): Promise<CheckResult> {
  const started = Date.now();
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS); // one budget for the whole chain
  const fail = (error: string, statusCode: number | null = null): CheckResult => ({
    monitor,
    ok: false,
    statusCode,
    responseTimeMs: Date.now() - started,
    error,
    checkedAt: Date.now(),
  });

  try {
    let url = monitor.url;
    for (let hop = 0; ; hop++) {
      if (!budget.take()) return fail('Check cut short: subrequest budget for this run is used up');
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: { 'User-Agent': 'PingWard/1.0 (+https://github.com/vxlhr/pingward)' },
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('Location') : null;
      if (location) {
        await res.body?.cancel();
        if (hop >= MAX_REDIRECTS) return fail(`Too many redirects (> ${MAX_REDIRECTS})`, res.status);
        const next = new URL(location, url).toString();
        const blocked = checkTargetUrl(next);
        if (blocked) return fail(`Redirect blocked: ${blocked}`, res.status);
        url = next;
        continue;
      }

      const ranges = monitor.accepted_status ? parseAcceptedStatus(monitor.accepted_status) : null;
      const accepted = Array.isArray(ranges) ? isAccepted(res.status, ranges) : res.ok;
      if (!accepted || !monitor.keyword) {
        // No body needed: release the connection right away.
        await res.body?.cancel();
        if (!accepted) return fail(`HTTP ${res.status}`, res.status);
      } else if (!(await readHead(res, KEYWORD_SCAN_BYTES)).includes(monitor.keyword)) {
        return fail(`Keyword not found: "${monitor.keyword}"`, res.status);
      }
      return {
        monitor,
        ok: true,
        statusCode: res.status,
        responseTimeMs: Date.now() - started,
        error: null,
        checkedAt: Date.now(),
      };
    }
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    if (isTimeout) return fail(`Timeout (${REQUEST_TIMEOUT_MS / 1000}s)`);
    const message = err instanceof Error ? err.message : String(err);
    // The runtime reports DNS / connection failures as an opaque "internal error; reference = …".
    return fail(/internal error/i.test(message) ? 'Connection failed (DNS lookup or network error)' : message);
  }
}

/**
 * Called by the cron: checks due monitors in parallel, stores results, sends alerts.
 * Every subrequest (D1 call, fetch hop, alert) is counted against the plan's per-run limit.
 */
export async function runScheduledChecks(env: Env, scheduledTime: number, budgetLimit?: number): Promise<CheckResult[]> {
  // One subrequest for both reads.
  const [settingsRes, monitorsRes] = await env.DB.batch([
    env.DB.prepare(SELECT_SETTINGS_SQL),
    env.DB.prepare("SELECT * FROM monitors WHERE status != 'PAUSED'"),
  ]);
  const settings = settingsFromRows(settingsRes.results as { key: string; value: string }[]);
  const budget = new SubrequestBudget(budgetLimit ?? PLAN_LIMITS[settings.plan].subrequestsPerRun);
  // Pay for every D1 call of this run up front: the read above, the write batch below, the hourly prune.
  budget.spend(D1_CALLS_PER_RUN);
  // Never start more checks than can finish their worst-case redirect chain within the budget.
  const maxChecks = Math.min(settings.checksPerMinute, Math.floor(budget.remaining / (1 + MAX_REDIRECTS)));
  const due = selectDueMonitors(monitorsRes.results as Monitor[], scheduledTime, maxChecks);
  if (due.length === 0) return [];

  const settled = await Promise.allSettled(due.map((m) => checkMonitor(m, budget)));
  const results = settled
    .filter((s): s is PromiseFulfilledResult<CheckResult> => s.status === 'fulfilled')
    .map((s) => s.value);

  // All writes in a single D1 batch (one subrequest, atomic). The INSERTs are guarded by EXISTS
  // so a monitor deleted mid-check can't fail the whole batch.
  const statements: D1PreparedStatement[] = [];
  const updateIndex: number[] = [];
  for (const r of results) {
    const id = r.monitor.id;
    const prev = r.monitor.status;
    const next = nextState(r.monitor, r.ok);
    const hour = Math.floor(r.checkedAt / HOUR_MS) * HOUR_MS;

    // Incidents go first: their guards must see the status from before this check,
    // so a monitor paused mid-check neither opens nor closes one.
    if (next.status === 'DOWN' && prev !== 'DOWN') {
      // The outage began at the first failed check: the previous one, when this check confirms it.
      const startedAt = r.monitor.fail_streak > 0 ? (r.monitor.last_checked_at ?? r.checkedAt) : r.checkedAt;
      statements.push(
        env.DB.prepare(
          `INSERT INTO incidents (monitor_id, started_at, cause)
           SELECT ?1, ?2, ?3
           WHERE EXISTS (SELECT 1 FROM monitors WHERE id = ?1 AND status != 'PAUSED')
             AND NOT EXISTS (SELECT 1 FROM incidents WHERE monitor_id = ?1 AND ended_at IS NULL)`,
        ).bind(id, startedAt, r.error),
      );
    } else if (next.status === 'UP' && prev !== 'UP') {
      statements.push(
        env.DB.prepare(
          `UPDATE incidents SET ended_at = ?2 WHERE monitor_id = ?1 AND ended_at IS NULL
             AND EXISTS (SELECT 1 FROM monitors WHERE id = ?1 AND status != 'PAUSED')`,
        ).bind(id, r.checkedAt),
      );
    }

    statements.push(
      env.DB.prepare(
        `INSERT INTO pings (monitor_id, status_code, response_time_ms, ok, error, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM monitors WHERE id = ?1)`,
      ).bind(id, r.statusCode, r.responseTimeMs, r.ok ? 1 : 0, r.error, r.checkedAt),
    );
    // Don't overwrite a monitor the user paused while the check was running.
    updateIndex.push(statements.length);
    statements.push(
      env.DB.prepare(
        `UPDATE monitors SET status = ?, fail_streak = ?, last_checked_at = ?, last_response_time_ms = ?
         WHERE id = ? AND status != 'PAUSED'`,
      ).bind(next.status, next.failStreak, r.checkedAt, r.responseTimeMs, id),
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO ping_stats_hourly (monitor_id, hour, checks, ok, response_ms_sum)
         SELECT ?1, ?2, 1, ?3, ?4 WHERE EXISTS (SELECT 1 FROM monitors WHERE id = ?1)
         ON CONFLICT (monitor_id, hour) DO UPDATE SET
           checks = checks + 1, ok = ok + excluded.ok, response_ms_sum = response_ms_sum + excluded.response_ms_sum`,
      ).bind(id, hour, r.ok ? 1 : 0, r.responseTimeMs),
    );
  }
  const written = statements.length > 0 ? await env.DB.batch(statements) : [];
  // 0 changes on the monitor UPDATE = paused or deleted mid-check, so no alert.
  const updated = results.filter((_, i) => (written[updateIndex[i]]?.meta.changes ?? 0) > 0);

  // Discord / Telegram alerts for status transitions, within what's left of the budget.
  await sendAlerts(planAlerts(env, updated), budget);

  return results;
}

/**
 * Hourly housekeeping: rolls the hourly counters up into daily ones (for the status page),
 * then deletes old pings, stats and long-closed incidents to keep D1 small.
 */
export async function pruneOldData(env: Env, now: number): Promise<void> {
  const [settingsRes] = await env.DB.batch([env.DB.prepare(SELECT_SETTINGS_SQL)]);
  const { pingRetentionDays } = settingsFromRows(settingsRes.results as { key: string; value: string }[]);
  // From the start of the day an hour ago: right after midnight this also completes yesterday.
  const rollupFrom = Math.floor((now - HOUR_MS) / DAY_MS) * DAY_MS;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ping_stats_daily (monitor_id, day, checks, ok)
       SELECT monitor_id, (hour / ${DAY_MS}) * ${DAY_MS} AS d, SUM(checks), SUM(ok)
       FROM ping_stats_hourly WHERE hour >= ? GROUP BY monitor_id, d
       ON CONFLICT (monitor_id, day) DO UPDATE SET checks = excluded.checks, ok = excluded.ok`,
    ).bind(rollupFrom),
    env.DB.prepare('DELETE FROM ping_stats_daily WHERE day < ?').bind(now - DAILY_STATS_RETENTION_MS),
    env.DB.prepare('DELETE FROM pings WHERE created_at < ?').bind(now - pingRetentionDays * DAY_MS),
    env.DB.prepare('DELETE FROM ping_stats_hourly WHERE hour < ?').bind(now - STATS_RETENTION_MS),
    env.DB.prepare('DELETE FROM incidents WHERE ended_at < ?').bind(now - INCIDENT_RETENTION_MS),
  ]);
}
