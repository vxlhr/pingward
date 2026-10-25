import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth';
import { HTTPException } from 'hono/http-exception';
import {
  KEYWORD_MAX_LENGTH,
  MAINTENANCE_MAX_MINUTES,
  PLAN_LIMITS,
  STATS_RANGES,
  loadOf,
  parseAcceptedStatus,
  type HealthInfo,
  type Incident,
  type Settings,
  type SettingsInfo,
  type StatsPoint,
  type StatsRange,
  type StatusPage,
  type TestAlertResult,
} from '@pingward/shared';
import type { Env, Monitor, MonitorSummary, Ping } from './types';
import { pruneOldData, runScheduledChecks } from './checker';
import { buildTestPayload, sendDiscord } from './discord';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, buildTelegramTest, getTelegramInfo, isBotItself, sendTelegram } from './telegram';
import { ACTIVE_LOAD_SQL, SELECT_SETTINGS_SQL, applySettingsPatch, settingsFromRows } from './settings';
import { checkTargetUrl, isDiscordWebhook } from './validation';
import { MIN_TOKEN_LENGTH, VALID_TOKEN, isStrongToken, safeEqual } from './auth';

const app = new Hono<{ Bindings: Env }>();

const isTrue = (v: string | undefined) => v?.toLowerCase() === 'true';

/**
 * Whether this request comes from the admin. Public reads don't require a token, but a valid one
 * unlocks private monitors. In local dev without a token (ALLOW_UNAUTHENTICATED_WRITES) everyone is admin.
 */
async function isAdmin(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const token = c.env.API_TOKEN?.trim();
  if (!token) return isTrue(c.env.ALLOW_UNAUTHENTICATED_WRITES);
  // Same rules as for writes: a malformed or weak token never grants admin access.
  if (!VALID_TOKEN.test(token) || !isStrongToken(token)) return false;
  const sent = /^Bearer\s+(.+)$/i.exec(c.req.header('Authorization') ?? '')?.[1]?.trim();
  return Boolean(sent) && (await safeEqual(token, sent as string));
}

const HOUR_MS = 60 * 60 * 1000;

// ---------- Middleware ----------

app.use('/api/*', async (c, next) => {
  const allowed = (c.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return cors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  })(c, next);
});

// Per-IP rate limit (protects the D1 read quota and the write endpoints).
app.use('/api/*', async (c, next) => {
  if (c.req.method === 'OPTIONS' || !c.env.API_RATE_LIMITER) return next();
  const key = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const { success } = await c.env.API_RATE_LIMITER.limit({ key });
  if (!success) {
    c.header('Retry-After', '60');
    return c.json({ error: 'Too many requests. Try again in a minute.' }, 429);
  }
  return next();
});

/**
 * Auth, fail closed:
 * - writes always need API_TOKEN; if it isn't configured they are refused
 *   (only `npm run dev` opts out with ALLOW_UNAUTHENTICATED_WRITES=true)
 * - reads are public unless READ_PROTECTED=true
 * - /api/health stays public so the dashboard knows what to ask for
 */
app.use('/api/*', async (c, next) => {
  if (c.req.method === 'OPTIONS' || c.req.path === '/api/health') return next();
  const isWrite = c.req.method !== 'GET' && c.req.method !== 'HEAD';
  const adminOnly = isWrite || c.req.path === '/api/telegram' || c.req.path === '/api/settings';
  if (!adminOnly && !isTrue(c.env.READ_PROTECTED)) return next();

  // Ignore surrounding whitespace / line breaks: they sneak in when a secret is pasted into a terminal prompt.
  const token = c.env.API_TOKEN?.trim();
  if (token) {
    // A token with other characters could never be sent as a valid Bearer token: say so instead of a silent 400.
    if (!VALID_TOKEN.test(token)) {
      return c.json({ error: 'API_TOKEN contains unsupported characters. Use only A-Z a-z 0-9 . _ ~ + / -' }, 500);
    }
    // One-click deploys make it easy to type something short; a guessable admin token is worse than none.
    if (!isStrongToken(token)) {
      return c.json({ error: `API_TOKEN is too weak. Use at least ${MIN_TOKEN_LENGTH} characters, e.g. a UUID.` }, 500);
    }
    return bearerAuth({ token })(c as unknown as Context, next);
  }
  if (adminOnly && isTrue(c.env.ALLOW_UNAUTHENTICATED_WRITES)) return next();
  return c.json({ error: 'API_TOKEN is not configured on the server, so this action is disabled.' }, 403);
});

// ---------- Validation ----------

interface MonitorInput {
  url: string;
  name: string;
  interval_minutes: number;
  discord_webhook: string | null;
  telegram_chat_id: string | null;
  is_public: boolean;
  accepted_status: string | null;
  keyword: string | null;
}

/**
 * Validates the optional check rules. Leaving a field out keeps it (undefined);
 * `null` or "" resets it to the default (null).
 */
function parseCheckRules(b: Record<string, unknown>, errors: string[]) {
  const rules: { accepted_status?: string | null; keyword?: string | null } = {};
  if (b.accepted_status !== undefined) {
    const raw = typeof b.accepted_status === 'string' ? b.accepted_status.trim() : b.accepted_status;
    if (raw === null || raw === '') rules.accepted_status = null;
    else if (typeof raw !== 'string') errors.push('accepted_status must be a string such as "200-299, 401"');
    else {
      const parsed = parseAcceptedStatus(raw);
      if (typeof parsed === 'string') errors.push(parsed);
      else rules.accepted_status = parsed.map(([a, z]) => (a === z ? `${a}` : `${a}-${z}`)).join(',');
    }
  }
  if (b.keyword !== undefined) {
    // Not trimmed: leading/trailing spaces can be part of what must appear on the page.
    const raw = b.keyword;
    if (raw === null || raw === '') rules.keyword = null;
    else if (typeof raw !== 'string' || raw.length > KEYWORD_MAX_LENGTH || !raw.trim()) {
      errors.push(`keyword must be 1-${KEYWORD_MAX_LENGTH} characters`);
    } else rules.keyword = raw;
  }
  return rules;
}

const isTelegramChatId = (v: string) => TELEGRAM_CHAT_ID.test(v);
const TELEGRAM_CHAT_ERROR = 'telegram_chat_id must be a numeric chat ID (e.g. 123456789 or -1001234567890) or @channelname';
const TELEGRAM_BOT_CHAT_ERROR =
  'telegram_chat_id is the bot itself, and bots can’t message bots. Use your own chat ID: message the bot, then use “Find my chat” (or ask @userinfobot).';

function parseMonitorInput(body: unknown, botToken?: string): MonitorInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: string[] = [];

  const url = typeof b.url === 'string' ? b.url.trim() : b.url;
  const urlError = checkTargetUrl(url);
  if (urlError) errors.push(urlError);

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 100) errors.push('name must be 1-100 characters');

  const interval = Number(b.interval_minutes ?? b.interval ?? 5);
  if (!Number.isInteger(interval) || interval < 1 || interval > 1440) {
    errors.push('interval_minutes must be an integer between 1 and 1440');
  }

  const rawHook = typeof b.discord_webhook === 'string' ? b.discord_webhook.trim() : '';
  if (rawHook && !isDiscordWebhook(rawHook)) errors.push('discord_webhook must be a Discord webhook URL');

  const rawChat = typeof b.telegram_chat_id === 'string' ? b.telegram_chat_id.trim() : '';
  if (rawChat && !isTelegramChatId(rawChat)) errors.push(TELEGRAM_CHAT_ERROR);
  else if (rawChat && isBotItself(rawChat, botToken)) errors.push(TELEGRAM_BOT_CHAT_ERROR);

  if (b.is_public !== undefined && typeof b.is_public !== 'boolean') errors.push('is_public must be true or false');
  const rules = parseCheckRules(b, errors);

  if (errors.length) throw new HTTPException(400, { message: errors.join('; ') });
  return {
    url: url as string,
    name,
    interval_minutes: interval,
    discord_webhook: rawHook || null,
    telegram_chat_id: rawChat || null,
    is_public: b.is_public !== false,
    accepted_status: rules.accepted_status ?? null,
    keyword: rules.keyword ?? null,
  };
}

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw new HTTPException(400, { message: 'Invalid id' });
  return id;
}

/** Never send alert destinations back to the client: the webhook URL is a secret, the chat ID private. */
function withoutWebhook({ discord_webhook, telegram_chat_id, is_public, ...rest }: Monitor) {
  return {
    ...rest,
    is_public: Boolean(is_public),
    has_webhook: discord_webhook !== null,
    has_telegram: telegram_chat_id !== null,
  };
}

/** 404 for anyone but the admin when a monitor is private (or doesn't exist). */
async function assertVisible(c: Context<{ Bindings: Env }>, id: number) {
  if (await isAdmin(c)) return;
  const row = await c.env.DB.prepare('SELECT is_public FROM monitors WHERE id = ?').bind(id).first<{ is_public: number }>();
  if (!row?.is_public) throw new HTTPException(404, { message: 'Monitor not found' });
}

// ---------- Routes ----------

app.get('/api/health', (c) =>
  c.json<HealthInfo>({
    name: 'PingWard API',
    status: 'ok',
    writeProtected: Boolean(c.env.API_TOKEN?.trim()) || !isTrue(c.env.ALLOW_UNAUTHENTICATED_WRITES),
    readProtected: isTrue(c.env.READ_PROTECTED),
    telegramEnabled: Boolean(c.env.TELEGRAM_BOT_TOKEN?.trim()),
  }),
);

const MONITOR_COLUMNS = `id, url, name, interval_minutes, status, last_checked_at, last_response_time_ms,
  fail_streak, accepted_status, keyword, maintenance_until,
  user_id, created_at, is_public, (discord_webhook IS NOT NULL) AS has_webhook, (telegram_chat_id IS NOT NULL) AS has_telegram`;

/** Uptime from hourly counters: ≤ 25 rows per monitor instead of every ping. */
const UPTIME_SQL = `SELECT monitor_id, SUM(checks) AS checks, SUM(ok) AS ok
  FROM ping_stats_hourly WHERE hour >= ?`;

/** Ongoing incidents (few rows: only monitors that are down right now). */
const OPEN_INCIDENTS_SQL = 'SELECT monitor_id, started_at FROM incidents WHERE ended_at IS NULL';

type UptimeRow = { monitor_id: number; checks: number; ok: number };
type OpenIncidentRow = { monitor_id: number; started_at: number };

function toSummaries(rows: Record<string, unknown>[], uptime: UptimeRow[], open: OpenIncidentRow[]): MonitorSummary[] {
  const byId = new Map(uptime.map((u) => [u.monitor_id, u]));
  const downSince = new Map(open.map((o) => [o.monitor_id, o.started_at]));
  return rows.map((row) => {
    const u = byId.get(row.id as number);
    return {
      ...(row as unknown as MonitorSummary),
      has_webhook: Boolean(row.has_webhook),
      has_telegram: Boolean(row.has_telegram),
      is_public: Boolean(row.is_public),
      uptime_24h: u && u.checks > 0 ? Math.round((u.ok / u.checks) * 10000) / 100 : null,
      down_since: row.status === 'DOWN' ? (downSince.get(row.id as number) ?? null) : null,
    };
  });
}

/** Start of the 24 h uptime window, aligned to the hourly buckets. */
const uptimeSince = () => Math.floor((Date.now() - 24 * HOUR_MS) / HOUR_MS) * HOUR_MS;

// GET /api/monitors: all monitors with their latest status
app.get('/api/monitors', async (c) => {
  const [monitors, uptime, open] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT ${MONITOR_COLUMNS} FROM monitors ${(await isAdmin(c)) ? '' : 'WHERE is_public = 1'} ORDER BY created_at DESC`,
    ),
    c.env.DB.prepare(`${UPTIME_SQL} GROUP BY monitor_id`).bind(uptimeSince()),
    c.env.DB.prepare(OPEN_INCIDENTS_SQL),
  ]);
  return c.json(
    toSummaries(
      monitors.results as Record<string, unknown>[],
      uptime.results as UptimeRow[],
      open.results as OpenIncidentRow[],
    ),
  );
});

// GET /api/monitors/:id: a single monitor
app.get('/api/monitors/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  await assertVisible(c, id);
  const [monitors, uptime, open] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT ${MONITOR_COLUMNS} FROM monitors WHERE id = ?`).bind(id),
    c.env.DB.prepare(`${UPTIME_SQL} AND monitor_id = ? GROUP BY monitor_id`).bind(uptimeSince(), id),
    c.env.DB.prepare(`${OPEN_INCIDENTS_SQL} AND monitor_id = ?`).bind(id),
  ]);
  const [summary] = toSummaries(
    monitors.results as Record<string, unknown>[],
    uptime.results as UptimeRow[],
    open.results as OpenIncidentRow[],
  );
  if (!summary) return c.json({ error: 'Monitor not found' }, 404);
  return c.json(summary);
});

async function loadSettingsAndUsage(db: D1Database) {
  const [settingsRes, usageRes] = await db.batch([
    db.prepare(SELECT_SETTINGS_SQL),
    db.prepare(`SELECT (${ACTIVE_LOAD_SQL}) AS load, (SELECT COUNT(*) FROM monitors) AS monitors`),
  ]);
  const settings = settingsFromRows(settingsRes.results as { key: string; value: string }[]);
  const row = (usageRes.results[0] ?? {}) as { load?: number; monitors?: number };
  return { settings, usage: { checksPerMinute: Number(row.load ?? 0), monitors: Number(row.monitors ?? 0) } };
}

function capacityError(settings: Settings, usage: { checksPerMinute: number }, interval: number) {
  const free = Math.max(0, settings.checksPerMinute - usage.checksPerMinute);
  const minInterval = free > 0 ? Math.ceil(1 / free - 1e-9) : null;
  return (
    `Not enough check capacity: active monitors use ${usage.checksPerMinute.toFixed(2)} of ${settings.checksPerMinute} checks per minute, ` +
    `and a ${interval}-minute interval needs ${loadOf(interval).toFixed(2)}. ` +
    (minInterval
      ? `Use an interval of ${minInterval} minutes or more, pause a monitor, or raise the capacity in Settings.`
      : 'Pause a monitor or raise the capacity in Settings.')
  );
}

// POST /api/monitors: create a monitor
app.post('/api/monitors', async (c) => {
  const body = await c.req.json().catch(() => {
    throw new HTTPException(400, { message: 'Body must be valid JSON' });
  });
  const input = parseMonitorInput(body, c.env.TELEGRAM_BOT_TOKEN);
  const { settings, usage } = await loadSettingsAndUsage(c.env.DB);
  const maxMonitors = PLAN_LIMITS[settings.plan].maxMonitors;
  // Capacity and count are re-checked inside the INSERT itself, so concurrent requests can't overshoot.
  const created = await c.env.DB.prepare(
    `INSERT INTO monitors (url, name, interval_minutes, discord_webhook, telegram_chat_id, is_public, accepted_status, keyword)
     SELECT ?1, ?2, ?3, ?4, ?7, ?8, ?9, ?10
     WHERE (SELECT COUNT(*) FROM monitors) < ?5
       AND (${ACTIVE_LOAD_SQL}) + 1.0 / ?3 <= ?6 + 1e-9
     RETURNING *`,
  )
    .bind(
      input.url,
      input.name,
      input.interval_minutes,
      input.discord_webhook,
      maxMonitors,
      settings.checksPerMinute,
      input.telegram_chat_id,
      input.is_public ? 1 : 0,
      input.accepted_status,
      input.keyword,
    )
    .first<Monitor>();
  if (!created) {
    const error =
      usage.monitors >= maxMonitors
        ? `Monitor limit reached (${maxMonitors} on the ${settings.plan} plan). Delete one to add another.`
        : capacityError(settings, usage, input.interval_minutes);
    return c.json({ error }, 409);
  }
  return c.json(withoutWebhook(created), 201);
});

const EDIT_FIELDS = [
  'url',
  'name',
  'interval_minutes',
  'discord_webhook',
  'telegram_chat_id',
  'is_public',
  'accepted_status',
  'keyword',
] as const;

/** Validates a partial edit; `null` or `""` for an alert destination means "remove". */
function parseMonitorEdit(b: Record<string, unknown>, botToken?: string) {
  const errors: string[] = [];
  const edit: {
    url?: string;
    name?: string;
    interval_minutes?: number;
    discord_webhook?: string | null;
    telegram_chat_id?: string | null;
    is_public?: boolean;
    accepted_status?: string | null;
    keyword?: string | null;
  } = {};

  if (b.url !== undefined) {
    const url = typeof b.url === 'string' ? b.url.trim() : b.url;
    const urlError = checkTargetUrl(url);
    if (urlError) errors.push(urlError);
    else edit.url = url as string;
  }
  if (b.name !== undefined) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 100) errors.push('name must be 1-100 characters');
    else edit.name = name;
  }
  if (b.interval_minutes !== undefined) {
    const interval = Number(b.interval_minutes);
    if (!Number.isInteger(interval) || interval < 1 || interval > 1440) {
      errors.push('interval_minutes must be an integer between 1 and 1440');
    } else edit.interval_minutes = interval;
  }
  if (b.discord_webhook !== undefined) {
    const hook = typeof b.discord_webhook === 'string' ? b.discord_webhook.trim() : b.discord_webhook;
    if (hook === null || hook === '') edit.discord_webhook = null;
    else if (typeof hook !== 'string' || !isDiscordWebhook(hook)) errors.push('discord_webhook must be a Discord webhook URL');
    else edit.discord_webhook = hook;
  }
  if (b.telegram_chat_id !== undefined) {
    const chat = typeof b.telegram_chat_id === 'string' ? b.telegram_chat_id.trim() : b.telegram_chat_id;
    if (chat === null || chat === '') edit.telegram_chat_id = null;
    else if (typeof chat !== 'string' || !isTelegramChatId(chat)) errors.push(TELEGRAM_CHAT_ERROR);
    else if (isBotItself(chat, botToken)) errors.push(TELEGRAM_BOT_CHAT_ERROR);
    else edit.telegram_chat_id = chat;
  }
  if (b.is_public !== undefined) {
    if (typeof b.is_public !== 'boolean') errors.push('is_public must be true or false');
    else edit.is_public = b.is_public;
  }
  Object.assign(edit, parseCheckRules(b, errors));
  if (errors.length) throw new HTTPException(400, { message: errors.join('; ') });
  return edit;
}

// PATCH /api/monitors/:id: edit fields, pause / resume (both need free capacity when they add load),
// or start / end a maintenance window
app.patch('/api/monitors/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const actions = [EDIT_FIELDS.some((f) => body[f] !== undefined), body.paused !== undefined, body.maintenance_minutes !== undefined];
  if (actions.filter(Boolean).length > 1) {
    throw new HTTPException(400, { message: 'Send edit fields, paused or maintenance_minutes, one at a time' });
  }

  if (body.maintenance_minutes !== undefined) {
    const minutes = body.maintenance_minutes;
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 0 || minutes > MAINTENANCE_MAX_MINUTES) {
      throw new HTTPException(400, { message: `maintenance_minutes must be an integer between 0 (end it) and ${MAINTENANCE_MAX_MINUTES}` });
    }
    const now = Date.now();
    // Starting: the monitor isn't checked until then, so its status starts over and an ongoing outage
    // is closed. Ending: check it right away.
    const [, updated] = await c.env.DB.batch([
      c.env.DB.prepare('UPDATE incidents SET ended_at = ?2 WHERE monitor_id = ?1 AND ended_at IS NULL AND ?3 > 0').bind(id, now, minutes),
      minutes > 0
        ? c.env.DB.prepare(
            `UPDATE monitors SET maintenance_until = ?2, fail_streak = 0,
               status = CASE WHEN status = 'PAUSED' THEN status ELSE 'PENDING' END
             WHERE id = ?1 RETURNING *`,
          ).bind(id, now + minutes * 60_000)
        : c.env.DB.prepare('UPDATE monitors SET maintenance_until = NULL, last_checked_at = NULL WHERE id = ?1 RETURNING *').bind(id),
    ]);
    const row = updated.results[0] as Monitor | undefined;
    if (!row) return c.json({ error: 'Monitor not found' }, 404);
    return c.json(withoutWebhook(row));
  }

  if (EDIT_FIELDS.some((f) => body[f] !== undefined)) {
    const edit = parseMonitorEdit(body, c.env.TELEGRAM_BOT_TOKEN);
    const existing = await c.env.DB.prepare('SELECT * FROM monitors WHERE id = ?').bind(id).first<Monitor>();
    if (!existing) return c.json({ error: 'Monitor not found' }, 404);

    const { settings, usage } = await loadSettingsAndUsage(c.env.DB);
    const urlChanged = edit.url !== undefined && edit.url !== existing.url;
    const interval = edit.interval_minutes ?? existing.interval_minutes;
    const hookChanged = edit.discord_webhook !== undefined;
    const chatChanged = edit.telegram_chat_id !== undefined;
    const statusChanged = edit.accepted_status !== undefined && edit.accepted_status !== existing.accepted_status;
    const keywordChanged = edit.keyword !== undefined && edit.keyword !== existing.keyword;
    // New URL or new rules: the next check (right away) starts from a clean slate.
    const recheck = urlChanged || statusChanged || keywordChanged;
    // A shorter interval on an active monitor must still fit; checked inside the UPDATE (no race).
    const updated = await c.env.DB.prepare(
      `UPDATE monitors SET
         name = ?2, url = ?3, interval_minutes = ?4,
         discord_webhook = CASE WHEN ?5 THEN ?6 ELSE discord_webhook END,
         telegram_chat_id = CASE WHEN ?9 THEN ?10 ELSE telegram_chat_id END,
         is_public = CASE WHEN ?11 THEN ?12 ELSE is_public END,
         accepted_status = ?13, keyword = ?14,
         fail_streak = CASE WHEN ?15 THEN 0 ELSE fail_streak END,
         status = CASE WHEN ?7 AND status != 'PAUSED' THEN 'PENDING' ELSE status END,
         last_checked_at = CASE WHEN ?15 OR ?4 != interval_minutes THEN NULL ELSE last_checked_at END,
         last_response_time_ms = CASE WHEN ?7 THEN NULL ELSE last_response_time_ms END
       WHERE id = ?1
         AND (status = 'PAUSED' OR (${ACTIVE_LOAD_SQL}) - 1.0 / interval_minutes + 1.0 / ?4 <= ?8 + 1e-9)
       RETURNING *`,
    )
      .bind(
        id,
        edit.name ?? existing.name,
        edit.url ?? existing.url,
        interval,
        hookChanged ? 1 : 0,
        edit.discord_webhook ?? null,
        urlChanged ? 1 : 0,
        settings.checksPerMinute,
        chatChanged ? 1 : 0,
        edit.telegram_chat_id ?? null,
        edit.is_public === undefined ? 0 : 1,
        edit.is_public ? 1 : 0,
        edit.accepted_status === undefined ? existing.accepted_status : edit.accepted_status,
        edit.keyword === undefined ? existing.keyword : edit.keyword,
        recheck ? 1 : 0,
      )
      .first<Monitor>();
    if (!updated) {
      const others = { checksPerMinute: Math.max(0, usage.checksPerMinute - loadOf(existing.interval_minutes)) };
      return c.json({ error: capacityError(settings, others, interval) }, 409);
    }
    // A different URL is a different target: close its ongoing incident.
    if (urlChanged) {
      await c.env.DB.prepare('UPDATE incidents SET ended_at = ? WHERE monitor_id = ? AND ended_at IS NULL')
        .bind(Date.now(), id)
        .run();
    }
    return c.json(withoutWebhook(updated));
  }

  if (typeof body.paused !== 'boolean') {
    throw new HTTPException(400, { message: `Send paused (boolean) or at least one of: ${EDIT_FIELDS.join(', ')}` });
  }

  if (body.paused) {
    const paused = await c.env.DB.prepare("UPDATE monitors SET status = 'PAUSED' WHERE id = ? RETURNING *")
      .bind(id)
      .first<Monitor>();
    if (!paused) return c.json({ error: 'Monitor not found' }, 404);
    return c.json(withoutWebhook(paused));
  }

  const { settings, usage } = await loadSettingsAndUsage(c.env.DB);
  // Resuming an already active monitor is a no-op; a paused one must fit in the remaining capacity.
  const resumed = await c.env.DB.prepare(
    `UPDATE monitors SET status = 'PENDING', fail_streak = 0, last_checked_at = NULL
     WHERE id = ?1 AND status = 'PAUSED' AND (${ACTIVE_LOAD_SQL}) + 1.0 / interval_minutes <= ?2 + 1e-9
     RETURNING *`,
  )
    .bind(id, settings.checksPerMinute)
    .first<Monitor>();
  if (resumed) return c.json(withoutWebhook(resumed));

  const existing = await c.env.DB.prepare('SELECT * FROM monitors WHERE id = ?').bind(id).first<Monitor>();
  if (!existing) return c.json({ error: 'Monitor not found' }, 404);
  if (existing.status !== 'PAUSED') return c.json(withoutWebhook(existing));
  return c.json({ error: capacityError(settings, usage, existing.interval_minutes) }, 409);
});

// DELETE /api/monitors/:id
app.delete('/api/monitors/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  const [, , , , del] = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM pings WHERE monitor_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM ping_stats_hourly WHERE monitor_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM ping_stats_daily WHERE monitor_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM incidents WHERE monitor_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM monitors WHERE id = ?').bind(id),
  ]);
  if (!del.meta.changes) return c.json({ error: 'Monitor not found' }, 404);
  return c.body(null, 204);
});

// POST /api/monitors/:id/test-alert: send a test message to every alert channel the monitor has
app.post('/api/monitors/:id/test-alert', async (c) => {
  const id = parseId(c.req.param('id'));
  const monitor = await c.env.DB.prepare('SELECT * FROM monitors WHERE id = ?').bind(id).first<Monitor>();
  if (!monitor) return c.json({ error: 'Monitor not found' }, 404);
  if (!monitor.discord_webhook && !monitor.telegram_chat_id) {
    return c.json({ error: 'This monitor has no alert channel. Add a Discord webhook or a Telegram chat by editing it.' }, 400);
  }

  const results: TestAlertResult['results'] = [];
  if (monitor.discord_webhook) {
    try {
      const status = await sendDiscord(monitor.discord_webhook, buildTestPayload(monitor));
      if (status < 300) results.push({ channel: 'discord', ok: true });
      else {
        const hint = status === 404 || status === 401 ? ' The webhook may have been deleted in Discord.' : '';
        results.push({ channel: 'discord', ok: false, error: `Discord rejected the message (HTTP ${status}).${hint}` });
      }
    } catch {
      results.push({ channel: 'discord', ok: false, error: "Couldn't reach Discord. Try again in a moment." });
    }
  }
  if (monitor.telegram_chat_id) {
    const token = c.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
      results.push({ channel: 'telegram', ok: false, error: 'TELEGRAM_BOT_TOKEN is not set on the Worker.' });
    } else if (!TELEGRAM_BOT_TOKEN.test(token)) {
      results.push({ channel: 'telegram', ok: false, error: 'TELEGRAM_BOT_TOKEN has an unexpected format. Copy it again from @BotFather.' });
    } else {
      const sent = await sendTelegram(token, monitor.telegram_chat_id, buildTelegramTest(monitor));
      results.push(sent.ok ? { channel: 'telegram', ok: true } : { channel: 'telegram', ok: false, error: sent.error });
    }
  }
  return c.json<TestAlertResult>({ results }, results.every((r) => r.ok) ? 200 : 502);
});

// GET /api/telegram: bot status and chats that recently messaged it (admin only: shows chat names)
app.get('/api/telegram', async (c) => c.json(await getTelegramInfo(c.env.TELEGRAM_BOT_TOKEN?.trim())));

// GET /api/monitors/:id/incidents: outage history, newest first
app.get('/api/monitors/:id/incidents', async (c) => {
  const id = parseId(c.req.param('id'));
  await assertVisible(c, id);
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 100);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT ?',
  )
    .bind(id, limit)
    .all<Incident>();
  return c.json(results);
});

// GET /api/monitors/:id/pings: latest pings for the chart, oldest to newest
app.get('/api/monitors/:id/pings', async (c) => {
  const id = parseId(c.req.param('id'));
  await assertVisible(c, id);
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 500);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM pings WHERE monitor_id = ? ORDER BY created_at DESC LIMIT ?',
  )
    .bind(id, limit)
    .all<Ping>();
  return c.json(results.reverse());
});

// GET /api/monitors/:id/stats?range=24h|7d|30d: hourly uptime and average response time
app.get('/api/monitors/:id/stats', async (c) => {
  const id = parseId(c.req.param('id'));
  const range = c.req.query('range') ?? '24h';
  if (!Object.hasOwn(STATS_RANGES, range)) {
    throw new HTTPException(400, { message: `range must be one of: ${Object.keys(STATS_RANGES).join(', ')}` });
  }
  await assertVisible(c, id);
  const since = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - (STATS_RANGES[range as StatsRange] - 1) * HOUR_MS;
  const { results } = await c.env.DB.prepare(
    'SELECT hour, checks, ok, response_ms_sum FROM ping_stats_hourly WHERE monitor_id = ? AND hour >= ? ORDER BY hour',
  )
    .bind(id, since)
    .all<{ hour: number; checks: number; ok: number; response_ms_sum: number }>();
  return c.json<StatsPoint[]>(
    results.map((r) => ({
      hour: r.hour,
      checks: r.checks,
      ok: r.ok,
      // Hours from before response times were recorded have a 0 sum: unknown, not 0 ms.
      avg_ms: r.checks > 0 && r.response_ms_sum > 0 ? Math.round(r.response_ms_sum / r.checks) : null,
    })),
  );
});

const STATUS_DAYS = 90;
const DAY_MS = 24 * HOUR_MS;

// GET /api/status: public status page (public monitors only, even for the admin)
app.get('/api/status', async (c) => {
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const from = today - (STATUS_DAYS - 1) * DAY_MS;
  const PUBLIC_JOIN = 'JOIN monitors m ON m.id = s.monitor_id AND m.is_public = 1';
  const [monitors, daily, todayRows, incidents] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT id, name, status, maintenance_until FROM monitors WHERE is_public = 1 ORDER BY created_at'),
    // Finished days come from the daily rollup, today from the live hourly counters.
    c.env.DB.prepare(
      `SELECT s.monitor_id, s.day, s.checks, s.ok FROM ping_stats_daily s ${PUBLIC_JOIN}
       WHERE s.day >= ? AND s.day < ? ORDER BY s.day`,
    ).bind(from, today),
    c.env.DB.prepare(
      `SELECT s.monitor_id, SUM(s.checks) AS checks, SUM(s.ok) AS ok FROM ping_stats_hourly s ${PUBLIC_JOIN}
       WHERE s.hour >= ? GROUP BY s.monitor_id`,
    ).bind(today),
    c.env.DB.prepare(
      `SELECT s.*, m.name AS monitor_name FROM incidents s ${PUBLIC_JOIN}
       WHERE s.started_at >= ? OR s.ended_at IS NULL ORDER BY s.started_at DESC LIMIT 20`,
    ).bind(today - 13 * DAY_MS),
  ]);

  type DayRow = { monitor_id: number; day: number; checks: number; ok: number };
  const days = new Map<number, DayRow[]>();
  for (const r of daily.results as DayRow[]) days.set(r.monitor_id, [...(days.get(r.monitor_id) ?? []), r]);
  for (const r of todayRows.results as Omit<DayRow, 'day'>[]) {
    if (r.checks > 0) days.set(r.monitor_id, [...(days.get(r.monitor_id) ?? []), { ...r, day: today }]);
  }

  c.header('Cache-Control', 'public, max-age=60');
  return c.json<StatusPage>({
    days: STATUS_DAYS,
    monitors: (monitors.results as Pick<Monitor, 'id' | 'name' | 'status' | 'maintenance_until'>[]).map((m) => {
      const list = (days.get(m.id) ?? []).map(({ day, checks, ok }) => ({ day, checks, ok }));
      const checks = list.reduce((s, d) => s + d.checks, 0);
      const ok = list.reduce((s, d) => s + d.ok, 0);
      return { ...m, uptime: checks > 0 ? Math.round((ok / checks) * 10000) / 100 : null, days: list };
    }),
    incidents: incidents.results as StatusPage['incidents'],
  });
});

// GET /api/settings: plan, capacity and current usage
app.get('/api/settings', async (c) => {
  const { settings, usage } = await loadSettingsAndUsage(c.env.DB);
  return c.json<SettingsInfo>({ settings, limits: PLAN_LIMITS, usage });
});

// PATCH /api/settings: change plan / capacity / retention (validated against current usage)
app.patch('/api/settings', async (c) => {
  const patch = await c.req.json().catch(() => {
    throw new HTTPException(400, { message: 'Body must be valid JSON' });
  });
  const { settings, usage } = await loadSettingsAndUsage(c.env.DB);
  const next = applySettingsPatch(settings, patch, usage);
  if (typeof next === 'string') return c.json({ error: next }, 400);
  await c.env.DB.batch(
    Object.entries(next).map(([key, value]) =>
      c.env.DB.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      ).bind(key, JSON.stringify(value)),
    ),
  );
  return c.json<SettingsInfo>({ settings: next, limits: PLAN_LIMITS, usage });
});

/**
 * The dashboard is built before anyone knows its URL, so link-preview tags (og:image, …) carry a
 * placeholder origin unless SITE_URL was set at build time. Swap in the real origin on the way out:
 * one-click deploys get correct previews with no extra step.
 */
const PLACEHOLDER_ORIGIN = 'https://pingward-site.invalid';

const withRealOrigin = async (c: Context<{ Bindings: Env }>) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (!res.headers.get('Content-Type')?.includes('text/html')) return res;
  const origin = new URL(c.req.url).origin;
  return new HTMLRewriter()
    .on(`meta[content^="${PLACEHOLDER_ORIGIN}"]`, {
      element(el) {
        const content = el.getAttribute('content');
        if (content) el.setAttribute('content', origin + content.slice(PLACEHOLDER_ORIGIN.length));
      },
    })
    .transform(res);
};
app.get('/', withRealOrigin);
app.get('/status', withRealOrigin);

// Other non-API paths normally never reach the Worker (see run_worker_first), but hand them to the assets just in case.
app.notFound((c) =>
  c.req.path.startsWith('/api/') ? c.json({ error: 'Not found' }, 404) : c.env.ASSETS.fetch(c.req.raw),
);

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    if (err.res) return err.res; // e.g. bearerAuth builds its own 401 response
    return c.json({ error: err.message }, err.status);
  }
  console.error(err);
  return c.json({ error: 'Internal server error' }, 500);
});

// ---------- Export: HTTP + Cron ----------

export default {
  fetch: app.fetch,

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const now = controller.scheduledTime;
    const results = await runScheduledChecks(env, now);
    console.log(`PingWard cron: ${results.length} monitor(s) checked`);
    // Prune old data once an hour.
    if (new Date(now).getUTCMinutes() === 0) ctx.waitUntil(pruneOldData(env, now));
  },
} satisfies ExportedHandler<Env>;

export { app };
