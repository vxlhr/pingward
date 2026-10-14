import { DEFAULT_SETTINGS, PLAN_LIMITS, RETENTION_RANGE, type Plan, type Settings } from '@pingward/shared';

export const SELECT_SETTINGS_SQL = 'SELECT key, value FROM settings';

/** SQL fragment: checks per minute the active monitors currently need (Σ 1/interval). */
export const ACTIVE_LOAD_SQL = "SELECT COALESCE(SUM(1.0 / interval_minutes), 0) FROM monitors WHERE status != 'PAUSED'";

const isPlan = (v: unknown): v is Plan => v === 'free' || v === 'paid';
const isIntIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Builds settings from stored rows, ignoring anything invalid and clamping to the plan's ceiling. */
export function settingsFromRows(rows: { key: string; value: string }[]): Settings {
  const raw: Record<string, unknown> = {};
  for (const { key, value } of rows) {
    try {
      raw[key] = JSON.parse(value);
    } catch {
      /* ignore corrupt value, default applies */
    }
  }
  const plan = isPlan(raw.plan) ? raw.plan : DEFAULT_SETTINGS.plan;
  const max = PLAN_LIMITS[plan].maxChecksPerMinute;
  return {
    plan,
    checksPerMinute: isIntIn(raw.checksPerMinute, 1, max) ? raw.checksPerMinute : Math.min(DEFAULT_SETTINGS.checksPerMinute, max),
    pingRetentionDays: isIntIn(raw.pingRetentionDays, RETENTION_RANGE.min, RETENTION_RANGE.max)
      ? raw.pingRetentionDays
      : DEFAULT_SETTINGS.pingRetentionDays,
  };
}

export interface Usage {
  checksPerMinute: number;
  monitors: number;
}

/**
 * Validates a settings change. Returns the new settings or an error message.
 * A change may not leave the current monitors without capacity.
 */
export function applySettingsPatch(current: Settings, patch: unknown, usage: Usage): Settings | string {
  const p = (patch ?? {}) as Record<string, unknown>;
  if (p.plan !== undefined && !isPlan(p.plan)) return 'plan must be "free" or "paid"';
  const plan = (p.plan as Plan | undefined) ?? current.plan;
  const limits = PLAN_LIMITS[plan];

  let checksPerMinute = current.checksPerMinute;
  if (p.checksPerMinute !== undefined) {
    if (!isIntIn(p.checksPerMinute, 1, limits.maxChecksPerMinute)) {
      return `checksPerMinute must be an integer between 1 and ${limits.maxChecksPerMinute} on the ${plan} plan`;
    }
    checksPerMinute = p.checksPerMinute;
  } else {
    checksPerMinute = Math.min(checksPerMinute, limits.maxChecksPerMinute);
  }

  let pingRetentionDays = current.pingRetentionDays;
  if (p.pingRetentionDays !== undefined) {
    if (!isIntIn(p.pingRetentionDays, RETENTION_RANGE.min, RETENTION_RANGE.max)) {
      return `pingRetentionDays must be an integer between ${RETENTION_RANGE.min} and ${RETENTION_RANGE.max}`;
    }
    pingRetentionDays = p.pingRetentionDays;
  }

  if (usage.checksPerMinute > checksPerMinute + 1e-9) {
    return `Your active monitors need ${usage.checksPerMinute.toFixed(2)} checks per minute. Pause some or use longer intervals before lowering capacity to ${checksPerMinute}.`;
  }
  if (usage.monitors > limits.maxMonitors) {
    return `The ${plan} plan allows ${limits.maxMonitors} monitors and you have ${usage.monitors}. Delete some first.`;
  }
  return { plan, checksPerMinute, pingRetentionDays };
}
