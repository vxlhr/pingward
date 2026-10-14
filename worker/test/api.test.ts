import { describe, expect, it, vi } from 'vitest';
import { PLAN_LIMITS, type TelegramInfo, type TestAlertResult } from '@pingward/shared';
import { app } from '../src/index';
import type { Env } from '../src/types';

const unreachable = () =>
  vi.fn(() => {
    throw new Error('DB should not have been called');
  });

/** Env whose DB must never be reached: for validation / auth / rate-limit paths. */
function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: { prepare: unreachable(), batch: unreachable() } as unknown as D1Database,
    ASSETS: { fetch: unreachable() } as unknown as Fetcher,
    ALLOWED_ORIGINS: 'http://localhost:3000',
    ALLOW_UNAUTHENTICATED_WRITES: 'true',
    ...overrides,
  };
}

interface DbState {
  settings?: Record<string, unknown>;
  load?: number;
  monitors?: number;
  /** What the guarded INSERT/UPDATE ... RETURNING returns (null = condition failed). */
  first?: unknown;
  all?: unknown[];
}

/**
 * DB stub for the capacity-aware routes: batch() answers [settings, usage] reads
 * (and anything else with empty results); prepare().bind().first()/all() return the given values.
 */
function envWithDb(state: DbState, overrides: Partial<Env> = {}): Env {
  const stmt = {
    bind: () => stmt,
    first: async () => state.first ?? null,
    all: async () => ({ results: state.all ?? [] }),
  };
  const settingsRows = Object.entries(state.settings ?? {}).map(([key, v]) => ({ key, value: JSON.stringify(v) }));
  const batch = vi.fn(async (statements: unknown[]) =>
    statements.length === 2
      ? [{ results: settingsRows }, { results: [{ load: state.load ?? 0, monitors: state.monitors ?? 0 }] }]
      : statements.map(() => ({ results: [], meta: { changes: 1 } })),
  );
  return env({ DB: { prepare: () => stmt, batch } as unknown as D1Database, ...overrides });
}

const send = (method: string, body: unknown, headers: Record<string, string> = {}) =>
  ({ method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } }) as RequestInit;
const post = (body: unknown, headers?: Record<string, string>) => send('POST', body, headers);

const valid = { url: 'https://example.com', name: 'Example', interval_minutes: 5 };

describe('POST /api/monitors validation', () => {
  it('rejects invalid fields with 400', async () => {
    const res = await app.request('/api/monitors', post({ url: 'ftp://x', name: '' }), env());
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('url');
    expect(error).toContain('name');
  });

  it('rejects non-Discord webhook URLs', async () => {
    const res = await app.request('/api/monitors', post({ ...valid, discord_webhook: 'https://evil.example/api/webhooks/1' }), env());
    expect(res.status).toBe(400);
  });

  it('rejects private and local targets', async () => {
    for (const url of ['http://localhost:8080', 'http://192.168.1.1', 'http://169.254.169.254/latest/meta-data']) {
      const res = await app.request('/api/monitors', post({ ...valid, url }), env());
      expect(res.status, url).toBe(400);
    }
  });

  it('returns 400 for an invalid id', async () => {
    const res = await app.request('/api/monitors/abc/pings', {}, env());
    expect(res.status).toBe(400);
  });
});

describe('capacity', () => {
  const row = {
    id: 1,
    ...valid,
    status: 'PENDING',
    last_checked_at: null,
    last_response_time_ms: null,
    user_id: null,
    created_at: 0,
    discord_webhook: 'https://discord.com/api/webhooks/1/secret',
  };

  it('explains how to fit when check capacity is used up', async () => {
    const res = await app.request('/api/monitors', post({ ...valid, interval_minutes: 1 }), envWithDb({ load: 6.5, monitors: 10 }));
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('6.50 of 7 checks per minute');
    expect(error).toContain('interval of 2 minutes or more');
  });

  it('reports the plan monitor cap', async () => {
    const res = await app.request('/api/monitors', post(valid), envWithDb({ monitors: PLAN_LIMITS.free.maxMonitors }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(`${PLAN_LIMITS.free.maxMonitors} on the free plan`);
  });

  it('creates the monitor and never returns the webhook URL', async () => {
    const res = await app.request('/api/monitors', post(valid), envWithDb({ first: row }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('discord_webhook');
    expect(body.has_webhook).toBe(true);
  });

  it('refuses to resume a paused monitor when there is no capacity left', async () => {
    // Guarded UPDATE returns nothing; the follow-up lookup finds the monitor still paused.
    const stmtFirst = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ ...row, status: 'PAUSED', interval_minutes: 1 });
    const e = envWithDb({ load: 7 });
    (e.DB as unknown as { prepare: () => unknown }).prepare = () => {
      const s = { bind: () => s, first: stmtFirst };
      return s;
    };
    const res = await app.request('/api/monitors/1', send('PATCH', { paused: false }), e);
    expect(res.status).toBe(409);
  });
});

describe('editing a monitor', () => {
  const existing = {
    id: 1,
    url: 'https://example.com',
    name: 'Example',
    interval_minutes: 5,
    status: 'UP',
    last_checked_at: 1,
    last_response_time_ms: 100,
    user_id: null,
    created_at: 0,
    discord_webhook: null,
    telegram_chat_id: null,
  };

  /** first() answers in order: the SELECT of the existing row, then the guarded UPDATE ... RETURNING. */
  function envForEdit(updateResult: unknown, state: DbState = {}) {
    const e = envWithDb(state);
    const first = vi.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(updateResult);
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    (e.DB as unknown as { prepare: () => unknown }).prepare = () => {
      const s = { bind: () => s, first, run };
      return s;
    };
    return { env: e, run };
  }

  it('updates fields and never returns the webhook', async () => {
    const { env } = envForEdit({ ...existing, name: 'Renamed', discord_webhook: 'https://discord.com/api/webhooks/1/x' });
    const res = await app.request('/api/monitors/1', send('PATCH', { name: 'Renamed' }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe('Renamed');
    expect(body).not.toHaveProperty('discord_webhook');
  });

  it('closes the ongoing incident when the URL changes', async () => {
    const { env, run } = envForEdit({ ...existing, url: 'https://new.example' });
    await app.request('/api/monitors/1', send('PATCH', { url: 'https://new.example' }), env);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refuses a shorter interval that does not fit the capacity', async () => {
    const { env } = envForEdit(null, { load: 7 });
    const res = await app.request('/api/monitors/1', send('PATCH', { interval_minutes: 1 }), env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('Not enough check capacity');
  });

  it('validates edited fields', async () => {
    const res = await app.request('/api/monitors/1', send('PATCH', { url: 'http://10.0.0.1', interval_minutes: 0 }), env());
    expect(res.status).toBe(400);
  });

  it('rejects mixing edits with pause', async () => {
    const res = await app.request('/api/monitors/1', send('PATCH', { name: 'x', paused: true }), env());
    expect(res.status).toBe(400);
  });
});

describe('test alert', () => {
  const withWebhook = { id: 1, name: 'Example', url: 'https://example.com', discord_webhook: 'https://discord.com/api/webhooks/1/x' };

  it('posts a test embed to the webhook', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await app.request('/api/monitors/1/test-alert', { method: 'POST' }, envWithDb({ first: withWebhook }));
    vi.unstubAllGlobals();
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(withWebhook.discord_webhook);
    expect(JSON.parse(String(init.body)).embeds[0].title).toContain('Test alert');
  });

  it('explains a webhook Discord no longer accepts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    const res = await app.request('/api/monitors/1/test-alert', { method: 'POST' }, envWithDb({ first: withWebhook }));
    vi.unstubAllGlobals();
    expect(res.status).toBe(502);
    const { results } = (await res.json()) as TestAlertResult;
    expect(results).toEqual([{ channel: 'discord', ok: false, error: expect.stringContaining('deleted in Discord') }]);
  });

  it('needs a webhook on the monitor', async () => {
    const res = await app.request('/api/monitors/1/test-alert', { method: 'POST' }, envWithDb({ first: { ...withWebhook, discord_webhook: null } }));
    expect(res.status).toBe(400);
  });
});

describe('Telegram', () => {
  const TOKEN = '123456789:AAEexampleexampleexampleexample12345';
  const monitor = {
    id: 1,
    name: 'Example',
    url: 'https://example.com',
    discord_webhook: 'https://discord.com/api/webhooks/1/x',
    telegram_chat_id: '-1001234567890',
  };

  it('validates the chat ID on create', async () => {
    for (const telegram_chat_id of ['abc', '12 34', '@ab', 'https://t.me/x']) {
      const res = await app.request('/api/monitors', post({ ...valid, telegram_chat_id }), env());
      expect(res.status, telegram_chat_id).toBe(400);
    }
  });

  it('accepts numeric chat IDs and @channels, and only reports has_telegram', async () => {
    for (const telegram_chat_id of ['123456789', '-1001234567890', '@my_status_channel']) {
      const row = { id: 1, ...valid, status: 'PENDING', last_checked_at: null, last_response_time_ms: null, user_id: null, created_at: 0, discord_webhook: null, telegram_chat_id };
      const res = await app.request('/api/monitors', post({ ...valid, telegram_chat_id }), envWithDb({ first: row }));
      expect(res.status, telegram_chat_id).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty('telegram_chat_id');
      expect(body.has_telegram).toBe(true);
    }
  });

  it('test alert reports each channel separately', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith('https://api.telegram.org')
        ? Response.json({ ok: false, description: 'Bad Request: chat not found' }, { status: 400 })
        : new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await app.request('/api/monitors/1/test-alert', { method: 'POST' }, envWithDb({ first: monitor }, { TELEGRAM_BOT_TOKEN: TOKEN }));
    vi.unstubAllGlobals();
    expect(res.status).toBe(502);
    const { results } = (await res.json()) as TestAlertResult;
    expect(results[0]).toEqual({ channel: 'discord', ok: true });
    expect(results[1]).toMatchObject({ channel: 'telegram', ok: false, error: expect.stringContaining('Send any message to the bot first') });
    const tgCall = fetchMock.mock.calls.find(([u]) => String(u).includes('api.telegram.org')) as unknown as [string, RequestInit];
    expect(tgCall[0]).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(String(tgCall[1].body))).toMatchObject({ chat_id: '-1001234567890', parse_mode: 'HTML' });
  });

  it('says so when the bot token is missing', async () => {
    const res = await app.request('/api/monitors/1/test-alert', { method: 'POST' }, envWithDb({ first: { ...monitor, discord_webhook: null } }));
    const { results } = (await res.json()) as TestAlertResult;
    expect(results).toEqual([{ channel: 'telegram', ok: false, error: expect.stringContaining('TELEGRAM_BOT_TOKEN') }]);
  });

  it('lists chats that messaged the bot, for admins only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/getMe')
          ? Response.json({ ok: true, result: { username: 'pingward_bot', first_name: 'PingWard' } })
          : Response.json({
              ok: true,
              result: [
                { update_id: 1, message: { chat: { id: 111, type: 'private', first_name: 'Demir' } } },
                { update_id: 2, my_chat_member: { chat: { id: -1009, type: 'supergroup', title: 'Ops' } } },
              ],
            }),
      ),
    );
    const anonymous = await app.request('/api/telegram', {}, env({ API_TOKEN: 's3cret', TELEGRAM_BOT_TOKEN: TOKEN }));
    expect(anonymous.status).toBe(401);
    const res = await app.request('/api/telegram', { headers: { Authorization: 'Bearer s3cret' } }, env({ API_TOKEN: 's3cret', TELEGRAM_BOT_TOKEN: TOKEN }));
    vi.unstubAllGlobals();
    expect(await res.json()).toEqual<TelegramInfo>({
      configured: true,
      bot: { username: 'pingward_bot', name: 'PingWard' },
      chats: [
        { id: '-1009', title: 'Ops', type: 'supergroup' },
        { id: '111', title: 'Demir', type: 'private' },
      ],
    });
  });

  it('explains a webhook conflict instead of claiming there are no chats', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/getMe')
          ? Response.json({ ok: true, result: { username: 'shared_bot', first_name: 'Shared' } })
          : Response.json({ ok: false, description: "Conflict: can't use getUpdates method while webhook is active" }, { status: 409 }),
      ),
    );
    const res = await app.request('/api/telegram', {}, env({ TELEGRAM_BOT_TOKEN: TOKEN }));
    vi.unstubAllGlobals();
    const info = (await res.json()) as TelegramInfo;
    expect(info.chats).toEqual([]);
    expect(info.error).toContain('another app');
  });

  it('never calls getUpdates with allowed_updates (it would change the bot for other apps)', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json({ ok: true, result: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await app.request('/api/telegram', {}, env({ TELEGRAM_BOT_TOKEN: TOKEN }));
    vi.unstubAllGlobals();
    expect(fetchMock.mock.calls.map(([u]) => String(u)).join(' ')).not.toContain('allowed_updates');
  });

  it("refuses to save the bot's own ID or username as the chat", async () => {
    for (const telegram_chat_id of ['123456789', '@vxlhr_pingward_bot']) {
      const res = await app.request('/api/monitors', post({ ...valid, telegram_chat_id }), env({ TELEGRAM_BOT_TOKEN: TOKEN }));
      expect(res.status, telegram_chat_id).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('the bot itself');
    }
  });

  it('looks up chats with POST (never a cacheable GET) and never offers the bot itself', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input).includes('/getMe')
        ? Response.json({ ok: true, result: { username: 'pingward_bot', first_name: 'PingWard' } })
        : Response.json({
            ok: true,
            result: [
              { update_id: 1, my_chat_member: { chat: { id: 123456789, type: 'private', first_name: 'PingWard' } } },
              { update_id: 2, message: { chat: { id: 555, type: 'private', first_name: 'Demir' } } },
            ],
          }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await app.request('/api/telegram', {}, env({ TELEGRAM_BOT_TOKEN: TOKEN }));
    vi.unstubAllGlobals();
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === 'POST')).toBe(true);
    expect(((await res.json()) as TelegramInfo).chats).toEqual([{ id: '555', title: 'Demir', type: 'private' }]);
  });

  it('rejects a malformed bot token without calling Telegram', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await app.request('/api/monitors/1/test-alert', { method: 'POST' }, envWithDb({ first: { ...monitor, discord_webhook: null } }, { TELEGRAM_BOT_TOKEN: 'not-a-token' }));
    vi.unstubAllGlobals();
    const { results } = (await res.json()) as TestAlertResult;
    expect(results[0].error).toContain('unexpected format');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports when Telegram is not configured', async () => {
    const res = await app.request('/api/health', {}, env());
    expect(await res.json()).toMatchObject({ telegramEnabled: false });
    const info = await app.request('/api/telegram', {}, env());
    expect(await info.json()).toEqual({ configured: false, chats: [] });
  });
});

describe('private monitors', () => {
  /** DB stub that records SQL so we can see whether the public filter was applied. */
  function recordingEnv(firstRow: unknown, overrides: Partial<Env> = {}) {
    const sql: string[] = [];
    const stmt = (q: string) => {
      const s = { bind: () => s, first: async () => firstRow, all: async () => ({ results: [] }) };
      sql.push(q);
      return s;
    };
    const batch = vi.fn(async (statements: unknown[]) => statements.map(() => ({ results: [], meta: { changes: 1 } })));
    return { env: env({ DB: { prepare: stmt, batch } as unknown as D1Database, API_TOKEN: 's3cret', ...overrides }), sql };
  }

  it('anonymous visitors only get public monitors', async () => {
    const { env: e, sql } = recordingEnv(null);
    await app.request('/api/monitors', {}, e);
    expect(sql.find((q) => q.includes('FROM monitors'))).toContain('WHERE is_public = 1');
  });

  it('the admin gets every monitor', async () => {
    const { env: e, sql } = recordingEnv(null);
    await app.request('/api/monitors', { headers: { Authorization: 'Bearer s3cret' } }, e);
    expect(sql.find((q) => q.includes('FROM monitors'))).not.toContain('is_public = 1');
  });

  it('a wrong token is treated as anonymous, not rejected', async () => {
    const { env: e, sql } = recordingEnv(null);
    const res = await app.request('/api/monitors', { headers: { Authorization: 'Bearer nope' } }, e);
    expect(res.status).toBe(200);
    expect(sql.find((q) => q.includes('FROM monitors'))).toContain('WHERE is_public = 1');
  });

  it.each(['/api/monitors/1', '/api/monitors/1/pings', '/api/monitors/1/incidents'])('%s is 404 for anonymous visitors when private', async (path) => {
    const { env: e } = recordingEnv({ is_public: 0 });
    expect((await app.request(path, {}, e)).status).toBe(404);
  });

  it('settings (capacity usage) are admin only', async () => {
    const { env: e } = recordingEnv(null);
    expect((await app.request('/api/settings', {}, e)).status).toBe(401);
  });

  it('validates is_public', async () => {
    const res = await app.request('/api/monitors', post({ ...valid, is_public: 'no' }), env());
    expect(res.status).toBe(400);
  });
});

describe('settings API', () => {
  it('returns settings, plan limits and usage', async () => {
    const res = await app.request('/api/settings', {}, envWithDb({ load: 2.5, monitors: 12 }));
    expect(await res.json()).toMatchObject({
      settings: { plan: 'free', checksPerMinute: 7, pingRetentionDays: 7 },
      limits: PLAN_LIMITS,
      usage: { checksPerMinute: 2.5, monitors: 12 },
    });
  });

  it('saves a valid change', async () => {
    const res = await app.request('/api/settings', send('PATCH', { plan: 'paid', checksPerMinute: 30 }), envWithDb({}));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { settings: unknown }).settings).toMatchObject({ plan: 'paid', checksPerMinute: 30 });
  });

  it('rejects capacity over the free ceiling', async () => {
    const res = await app.request('/api/settings', send('PATCH', { checksPerMinute: 50 }), envWithDb({}));
    expect(res.status).toBe(400);
  });

  it('requires the token to change settings', async () => {
    const res = await app.request('/api/settings', send('PATCH', { checksPerMinute: 4 }), env({ API_TOKEN: 's3cret' }));
    expect(res.status).toBe(401);
  });
});

describe('auth (fail closed)', () => {
  it('refuses writes when API_TOKEN is not configured', async () => {
    const res = await app.request('/api/monitors', post(valid), env({ ALLOW_UNAUTHENTICATED_WRITES: undefined }));
    expect(res.status).toBe(403);
  });

  it('requires the bearer token when API_TOKEN is set', async () => {
    const res = await app.request('/api/monitors', post(valid), env({ API_TOKEN: 's3cret' }));
    expect(res.status).toBe(401);
  });

  it('accepts the right token', async () => {
    const res = await app.request(
      '/api/monitors',
      post({ url: 'nope', name: 'A' }, { Authorization: 'Bearer s3cret' }),
      env({ API_TOKEN: 's3cret' }),
    );
    expect(res.status).toBe(400); // got past auth, failed validation
  });

  it('ignores a line break pasted around the secret', async () => {
    const res = await app.request(
      '/api/monitors',
      post({ url: 'nope', name: 'A' }, { Authorization: 'Bearer s3cret' }),
      env({ API_TOKEN: '\ns3cret\r\n' }),
    );
    expect(res.status).toBe(400); // got past auth, failed validation
  });

  it('explains a token with unsupported characters instead of failing silently', async () => {
    const res = await app.request('/api/monitors', post(valid, { Authorization: 'Bearer p@ss!' }), env({ API_TOKEN: 'p@ss!' }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain('unsupported characters');
  });

  it('keeps reads public by default', async () => {
    const res = await app.request('/api/monitors', {}, envWithDb({}, { API_TOKEN: 's3cret' }));
    expect(res.status).toBe(200);
  });

  it('protects reads when READ_PROTECTED=true', async () => {
    const res = await app.request('/api/monitors', {}, env({ API_TOKEN: 's3cret', READ_PROTECTED: 'true' }));
    expect(res.status).toBe(401);
  });

  it('reports the protection mode on /api/health without touching the DB', async () => {
    const res = await app.request('/api/health', {}, env({ ALLOW_UNAUTHENTICATED_WRITES: undefined, READ_PROTECTED: 'true' }));
    expect(await res.json()).toMatchObject({ writeProtected: true, readProtected: true });
  });
});

describe('rate limiting', () => {
  it('returns 429 with Retry-After when the limiter says no', async () => {
    const limiter = { limit: vi.fn().mockResolvedValue({ success: false }) } as unknown as RateLimit;
    const res = await app.request('/api/monitors', { headers: { 'CF-Connecting-IP': '203.0.113.7' } }, env({ API_RATE_LIMITER: limiter }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(limiter.limit).toHaveBeenCalledWith({ key: '203.0.113.7' });
  });
});

describe('CORS', () => {
  it('adds the header for allowed origins only', async () => {
    const preflight = (origin: string) =>
      app.request(
        '/api/monitors',
        { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } },
        env(),
      );
    expect((await preflight('http://localhost:3000')).headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect((await preflight('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
  });
});
