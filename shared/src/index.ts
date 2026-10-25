/** API models and limits shared by the Worker and the dashboard. */

export type MonitorStatus = 'PENDING' | 'UP' | 'DOWN' | 'PAUSED';

/** A monitor row as stored in D1. */
export interface Monitor {
  id: number;
  url: string;
  name: string;
  interval_minutes: number;
  status: MonitorStatus;
  last_checked_at: number | null;
  last_response_time_ms: number | null;
  discord_webhook: string | null;
  /** Telegram chat that receives this monitor's alerts (the bot token is a Worker secret). */
  telegram_chat_id: string | null;
  /** 1 = shown on the public dashboard, 0 = only signed-in admins see it. */
  is_public: number;
  /** Failed checks in a row; the monitor turns DOWN at CONFIRM_FAILURES. */
  fail_streak: number;
  /** Status codes that count as UP, e.g. "200-299,401". null = any 2xx. */
  accepted_status: string | null;
  /** Text the response body must contain. null = the body isn't read. */
  keyword: string | null;
  /** Checks (and alerts) are paused until this time (unix ms). */
  maintenance_until: number | null;
  user_id: string | null;
  created_at: number;
}

/** Monitor as returned by the read endpoints: alert destinations are never exposed, only whether they're set. */
export interface MonitorSummary extends Omit<Monitor, 'discord_webhook' | 'telegram_chat_id' | 'is_public'> {
  is_public: boolean;
  has_webhook: boolean;
  has_telegram: boolean;
  uptime_24h: number | null;
  /** Start of the ongoing incident, if the monitor is down. */
  down_since: number | null;
}

export interface Incident {
  id: number;
  monitor_id: number;
  started_at: number;
  /** null = still ongoing */
  ended_at: number | null;
  cause: string | null;
}

export interface Ping {
  id: number;
  monitor_id: number;
  status_code: number | null;
  response_time_ms: number;
  ok: 0 | 1;
  error: string | null;
  created_at: number;
}

export interface NewMonitor {
  url: string;
  name: string;
  interval_minutes: number;
  discord_webhook?: string;
  telegram_chat_id?: string;
  /** Default true. */
  is_public?: boolean;
  accepted_status?: string;
  keyword?: string;
}

/**
 * PATCH /api/monitors/:id edit body. Every field is optional; `null` removes an alert
 * destination (webhook / Telegram chat), leaving it out keeps the current one.
 */
export interface MonitorEdit {
  url?: string;
  name?: string;
  interval_minutes?: number;
  discord_webhook?: string | null;
  telegram_chat_id?: string | null;
  is_public?: boolean;
  /** `null` or "" = back to the default (any 2xx / no keyword). */
  accepted_status?: string | null;
  keyword?: string | null;
}

// ---------- Check rules ----------

/** Failed checks in a row before a monitor is DOWN (one blip never alerts). */
export const CONFIRM_FAILURES = 2;
/** How much of the body a keyword check reads. */
export const KEYWORD_SCAN_BYTES = 64 * 1024;
export const KEYWORD_MAX_LENGTH = 100;
/** Longest maintenance window that can be set at once. */
export const MAINTENANCE_MAX_MINUTES = 7 * 24 * 60;

/**
 * Parses "200-299, 301, 404" into ranges. Returns an error message for anything else
 * (codes 100-599, at most 10 entries).
 */
export function parseAcceptedStatus(raw: string): [number, number][] | string {
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  const error = 'accepted_status must be status codes or ranges between 100 and 599, e.g. "200-299, 401" (at most 10)';
  if (parts.length === 0 || parts.length > 10) return error;
  const ranges: [number, number][] = [];
  for (const part of parts) {
    const m = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(part);
    if (!m) return error;
    const from = Number(m[1]);
    const to = Number(m[2] ?? m[1]);
    if (from < 100 || to > 599 || from > to) return error;
    ranges.push([from, to]);
  }
  return ranges;
}

export const isAccepted = (status: number, ranges: [number, number][]) => ranges.some(([a, b]) => status >= a && status <= b);

/** Whether a maintenance window is active at `now`. */
export const inMaintenance = (m: { maintenance_until: number | null }, now: number) =>
  m.maintenance_until !== null && m.maintenance_until > now;

// ---------- Charts & status page ----------

export const STATS_RANGES = { '24h': 24, '7d': 7 * 24, '30d': 30 * 24 } as const;
export type StatsRange = keyof typeof STATS_RANGES;

/** GET /api/monitors/:id/stats?range=…: one point per hour. */
export interface StatsPoint {
  hour: number;
  checks: number;
  ok: number;
  /** Average response time over the hour's checks (null = no checks). */
  avg_ms: number | null;
}

/** GET /api/status: the public status page (public monitors only). */
export interface StatusPage {
  monitors: {
    id: number;
    name: string;
    status: MonitorStatus;
    maintenance_until: number | null;
    /** Uptime over the days shown, null = no checks yet. */
    uptime: number | null;
    /** Oldest first; days without checks are absent. */
    days: { day: number; checks: number; ok: number }[];
  }[];
  /** Recent incidents of the public monitors, newest first. */
  incidents: (Incident & { monitor_name: string })[];
  /** Number of days the bars cover. */
  days: number;
}

export type AlertChannel = 'discord' | 'telegram';

/** POST /api/monitors/:id/test-alert: one entry per configured channel. */
export interface TestAlertResult {
  results: { channel: AlertChannel; ok: boolean; error?: string }[];
}

/** GET /api/telegram: bot status plus chats that recently messaged the bot (to pick a chat ID). */
export interface TelegramInfo {
  configured: boolean;
  bot?: { username: string; name: string };
  chats: { id: string; title: string; type: string }[];
  error?: string;
}

/** GET /api/health: tells the dashboard which actions need a token. */
export interface HealthInfo {
  name: string;
  status: 'ok';
  writeProtected: boolean;
  readProtected: boolean;
  /** Whether TELEGRAM_BOT_TOKEN is set, so Telegram alerts can be configured. */
  telegramEnabled: boolean;
}

// ---------- Capacity & settings ----------

export type Plan = 'free' | 'paid';

/** Each check may follow up to this many redirects; every hop is one subrequest. */
export const MAX_REDIRECTS = 3;
/** D1 calls per cron run: one read batch, one write batch, plus the hourly prune (two batches). */
export const D1_CALLS_PER_RUN = 4;
/** Alert channels a single monitor can notify (Discord + Telegram). */
export const ALERT_CHANNELS = 2;

/**
 * Hard ceilings per Cloudflare plan. They keep any setting inside the platform limits.
 * Worst case per cron run = checks × (1 + MAX_REDIRECTS) + D1_CALLS_PER_RUN + checks × ALERT_CHANNELS:
 * free → 7 × 4 + 4 + 7 × 2 = 46 ≤ 50 subrequests; and ~6 D1 rows written per check →
 * 7 × 1440 × 6 ≈ 60k ≤ 100k rows/day. `worstCaseSubrequests` is asserted in the tests.
 */
export const PLAN_LIMITS: Record<Plan, { maxChecksPerMinute: number; maxMonitors: number; subrequestsPerRun: number }> = {
  free: { maxChecksPerMinute: 7, maxMonitors: 50, subrequestsPerRun: 50 },
  paid: { maxChecksPerMinute: 100, maxMonitors: 500, subrequestsPerRun: 1000 },
};

export const worstCaseSubrequests = (checks: number) =>
  checks * (1 + MAX_REDIRECTS) + D1_CALLS_PER_RUN + checks * ALERT_CHANNELS;

export interface Settings {
  plan: Plan;
  /** How many checks one cron run (every minute) may perform. */
  checksPerMinute: number;
  /** How long raw ping history is kept (the hourly uptime stats are kept 30 days). */
  pingRetentionDays: number;
}

export const DEFAULT_SETTINGS: Settings = { plan: 'free', checksPerMinute: 7, pingRetentionDays: 7 };

export const RETENTION_RANGE = { min: 1, max: 30 } as const;

/** GET /api/settings */
export interface SettingsInfo {
  settings: Settings;
  limits: typeof PLAN_LIMITS;
  usage: {
    /** Average checks per minute the active monitors need: Σ 1 / interval. */
    checksPerMinute: number;
    monitors: number;
  };
}

/** Checks per minute a monitor with this interval needs. */
export const loadOf = (intervalMinutes: number) => 1 / intervalMinutes;
