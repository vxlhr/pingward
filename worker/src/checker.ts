import { D1_CALLS_PER_RUN, MAX_REDIRECTS, PLAN_LIMITS } from '@pingward/shared';
import type { CheckResult, Env, Monitor, MonitorStatus } from './types';
import { SubrequestBudget, planAlerts, sendAlerts } from './alerts';
import { SELECT_SETTINGS_SQL, settingsFromRows } from './settings';
import { checkTargetUrl } from './validation';

export { MAX_REDIRECTS };

const REQUEST_TIMEOUT_MS = 10_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const STATS_RETENTION_MS = 30 * DAY_MS;
const INCIDENT_RETENTION_MS = 90 * DAY_MS;

/** Returns up to `limit` monitors that are due (or never checked), longest-waiting first. */
export function selectDueMonitors(monitors: Monitor[], now: number, limit: number): Monitor[] {
  return monitors
    .filter((m) => m.status !== 'PAUSED')
    .filter((m) => m.last_checked_at === null || now - m.last_checked_at >= m.interval_minutes * 60_000 - 5_000)
    .sort((a, b) => (a.last_checked_at ?? 0) - (b.last_checked_at ?? 0))
    .slice(0, limit);
}

/**
 * GETs the monitor URL, following redirects by hand so every hop is re-validated
 * (a public URL must not be able to bounce the check to a private address).
 * Every hop is one subrequest, taken from `budget`.
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
      // We don't need the body; release the connection right away.
      await res.body?.cancel();

      const location = res.status >= 300 && res.status < 400 ? res.headers.get('Location') : null;
      if (location) {
        if (hop >= MAX_REDIRECTS) return fail(`Too many redirects (> ${MAX_REDIRECTS})`, res.status);
        const next = new URL(location, url).toString();
        const blocked = checkTargetUrl(next);
        if (blocked) return fail(`Redirect blocked: ${blocked}`, res.status);
        url = next;
        continue;
      }

      return {
        monitor,
        ok: res.ok,
        statusCode: res.status,
        responseTimeMs: Date.now() - started,
        error: res.ok ? null : `HTTP ${res.status}`,
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
    const newStatus: MonitorStatus = r.ok ? 'UP' : 'DOWN';
    const hour = Math.floor(r.checkedAt / HOUR_MS) * HOUR_MS;

    // Incidents go first: their guards must see the status from before this check,
    // so a monitor paused mid-check neither opens nor closes one.
    if (!r.ok && prev !== 'DOWN') {
      statements.push(
        env.DB.prepare(
          `INSERT INTO incidents (monitor_id, started_at, cause)
           SELECT ?1, ?2, ?3
           WHERE EXISTS (SELECT 1 FROM monitors WHERE id = ?1 AND status != 'PAUSED')
             AND NOT EXISTS (SELECT 1 FROM incidents WHERE monitor_id = ?1 AND ended_at IS NULL)`,
        ).bind(id, r.checkedAt, r.error),
      );
    } else if (r.ok && prev !== 'UP') {
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
        `UPDATE monitors SET status = ?, last_checked_at = ?, last_response_time_ms = ?
         WHERE id = ? AND status != 'PAUSED'`,
      ).bind(newStatus, r.checkedAt, r.responseTimeMs, id),
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO ping_stats_hourly (monitor_id, hour, checks, ok)
         SELECT ?1, ?2, 1, ?3 WHERE EXISTS (SELECT 1 FROM monitors WHERE id = ?1)
         ON CONFLICT (monitor_id, hour) DO UPDATE SET checks = checks + 1, ok = ok + excluded.ok`,
      ).bind(id, hour, r.ok ? 1 : 0),
    );
  }
  const written = statements.length > 0 ? await env.DB.batch(statements) : [];
  // 0 changes on the monitor UPDATE = paused or deleted mid-check, so no alert.
  const updated = results.filter((_, i) => (written[updateIndex[i]]?.meta.changes ?? 0) > 0);

  // Discord / Telegram alerts for status transitions, within what's left of the budget.
  await sendAlerts(planAlerts(env, updated), budget);

  return results;
}

/** Deletes old pings, hourly stats and long-closed incidents to keep D1 small. */
export async function pruneOldData(env: Env, now: number): Promise<void> {
  const [settingsRes] = await env.DB.batch([env.DB.prepare(SELECT_SETTINGS_SQL)]);
  const { pingRetentionDays } = settingsFromRows(settingsRes.results as { key: string; value: string }[]);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM pings WHERE created_at < ?').bind(now - pingRetentionDays * DAY_MS),
    env.DB.prepare('DELETE FROM ping_stats_hourly WHERE hour < ?').bind(now - STATS_RETENTION_MS),
    env.DB.prepare('DELETE FROM incidents WHERE ended_at < ?').bind(now - INCIDENT_RETENTION_MS),
  ]);
}
