import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLAN_LIMITS, worstCaseSubrequests } from '@pingward/shared';
import { MAX_REDIRECTS, checkMonitor, runScheduledChecks, selectDueMonitors } from '../src/checker';
import { isAlertWorthy, nextState } from '../src/alerts';
import { buildDiscordPayload } from '../src/discord';
import type { Env, Monitor } from '../src/types';

const NOW = 1_800_000_000_000;

function monitor(overrides: Partial<Monitor> = {}): Monitor {
  return {
    id: 1,
    url: 'https://example.com',
    name: 'Example',
    interval_minutes: 5,
    status: 'UP',
    last_checked_at: NOW - 10 * 60_000,
    last_response_time_ms: null,
    discord_webhook: null,
    telegram_chat_id: null,
    is_public: 1,
    fail_streak: 0,
    accepted_status: null,
    keyword: null,
    maintenance_until: null,
    user_id: null,
    created_at: NOW - 86_400_000,
    ...overrides,
  };
}

const redirect = (location: string, status = 302) => new Response(null, { status, headers: { Location: location } });

describe('selectDueMonitors', () => {
  it('selects a monitor that was never checked', () => {
    expect(selectDueMonitors([monitor({ last_checked_at: null })], NOW, 8)).toHaveLength(1);
  });

  it('skips a monitor whose interval has not elapsed', () => {
    expect(selectDueMonitors([monitor({ last_checked_at: NOW - 2 * 60_000 })], NOW, 8)).toHaveLength(0);
  });

  it('tolerates 5 s of cron jitter', () => {
    const m = monitor({ interval_minutes: 1, last_checked_at: NOW - 57_000 });
    expect(selectDueMonitors([m], NOW, 8)).toHaveLength(1);
  });

  it('never selects PAUSED monitors', () => {
    expect(selectDueMonitors([monitor({ status: 'PAUSED', last_checked_at: null })], NOW, 8)).toHaveLength(0);
  });

  it('skips a monitor during its maintenance window, and picks it up again afterwards', () => {
    const m = monitor({ last_checked_at: null, maintenance_until: NOW + 60_000 });
    expect(selectDueMonitors([m], NOW, 8)).toHaveLength(0);
    expect(selectDueMonitors([m], NOW + 60_000, 8)).toHaveLength(1);
  });

  it('re-checks a failed monitor after a minute, ahead of the others', () => {
    const suspect = monitor({ id: 1, interval_minutes: 30, fail_streak: 1, last_checked_at: NOW - 60_000 });
    const waiting = monitor({ id: 2, last_checked_at: NOW - 60 * 60_000 });
    expect(selectDueMonitors([waiting, suspect], NOW, 1).map((m) => m.id)).toEqual([1]);
    // A confirmed outage goes back to the normal interval.
    expect(selectDueMonitors([{ ...suspect, status: 'DOWN' }], NOW, 8)).toHaveLength(0);
  });

  it('puts the longest-waiting first and respects the per-run capacity', () => {
    const many = Array.from({ length: 20 }, (_, i) => monitor({ id: i + 1, last_checked_at: NOW - (100 + i) * 60_000 }));
    const due = selectDueMonitors(many, NOW, 8);
    expect(due).toHaveLength(8);
    expect(due[0].id).toBe(20);
  });
});

describe('checkMonitor', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('treats 2xx as UP', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 200 })));
    const r = await checkMonitor(monitor());
    expect(r).toMatchObject({ ok: true, statusCode: 200, error: null });
    expect(r.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('treats 5xx as DOWN', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('err', { status: 503 })));
    expect(await checkMonitor(monitor())).toMatchObject({ ok: false, statusCode: 503, error: 'HTTP 503' });
  });

  it('accepts the configured status codes instead of 2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('login', { status: 401 })));
    expect(await checkMonitor(monitor({ accepted_status: '200-299,401' }))).toMatchObject({ ok: true, statusCode: 401 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    expect(await checkMonitor(monitor({ accepted_status: '204' }))).toMatchObject({ ok: false, error: 'HTTP 200' });
  });

  it('requires the keyword in the body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<h1>Welcome back</h1>', { status: 200 })));
    expect(await checkMonitor(monitor({ keyword: 'Welcome' }))).toMatchObject({ ok: true });
    expect(await checkMonitor(monitor({ keyword: 'Checkout' }))).toMatchObject({
      ok: false,
      statusCode: 200,
      error: 'Keyword not found: "Checkout"',
    });
  });

  it('only reads the first 64 KB of the body', async () => {
    const big = 'a'.repeat(64 * 1024) + 'needle';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(big, { status: 200 })));
    expect(await checkMonitor(monitor({ keyword: 'needle' }))).toMatchObject({ ok: false });
  });

  it('treats timeouts and network errors as DOWN', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout));
    expect(await checkMonitor(monitor())).toMatchObject({ ok: false, statusCode: null, error: 'Timeout (10s)' });
  });

  it('follows public redirects (relative ones too)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirect('https://www.example.com/'))
      .mockResolvedValueOnce(redirect('/home', 301))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await checkMonitor(monitor())).toMatchObject({ ok: true, statusCode: 200 });
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual([
      'https://example.com',
      'https://www.example.com/',
      'https://www.example.com/home',
    ]);
  });

  it('refuses a redirect to a private address', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirect('http://169.254.169.254/latest/meta-data'));
    vi.stubGlobal('fetch', fetchMock);
    const r = await checkMonitor(monitor());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^Redirect blocked/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it(`stops after ${MAX_REDIRECTS} redirects (subrequest budget)`, async () => {
    const fetchMock = vi.fn(async () => redirect('https://example.com/loop'));
    vi.stubGlobal('fetch', fetchMock);
    const r = await checkMonitor(monitor());
    expect(r.error).toMatch(/Too many redirects/);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });
});

describe('nextState / isAlertWorthy (failure confirmation)', () => {
  const result = (m: Monitor, ok: boolean) => ({ monitor: m, ok, statusCode: null, responseTimeMs: 1, error: null, checkedAt: NOW });

  it('one failed check keeps the status and does not alert', () => {
    expect(nextState(monitor(), false)).toEqual({ status: 'UP', failStreak: 1 });
    expect(isAlertWorthy(result(monitor(), false))).toBe(false);
    expect(isAlertWorthy(result(monitor({ status: 'PENDING' }), false))).toBe(false);
  });

  it('the second failure in a row turns it DOWN and alerts', () => {
    expect(nextState(monitor({ fail_streak: 1 }), false)).toEqual({ status: 'DOWN', failStreak: 2 });
    expect(isAlertWorthy(result(monitor({ fail_streak: 1 }), false))).toBe(true);
  });

  it('one success clears the streak; recovery alerts, a cleared blip does not', () => {
    expect(nextState(monitor({ fail_streak: 1 }), true)).toEqual({ status: 'UP', failStreak: 0 });
    expect(isAlertWorthy(result(monitor({ fail_streak: 1 }), true))).toBe(false);
    expect(isAlertWorthy(result(monitor({ status: 'DOWN', fail_streak: 4 }), true))).toBe(true);
  });
});

describe('buildDiscordPayload', () => {
  const base = { monitor: monitor(), statusCode: 503, responseTimeMs: 120, error: 'HTTP 503', checkedAt: NOW };

  it('builds a red embed for an outage', () => {
    const embed = buildDiscordPayload({ ...base, ok: false }).embeds[0];
    expect(embed.title).toContain('Site down');
    expect(embed.color).toBe(0xef4444);
    expect(embed.fields.some((f) => f.name === 'Error')).toBe(true);
  });

  it('builds a green embed for a recovery', () => {
    const embed = buildDiscordPayload({ ...base, ok: true, statusCode: 200, error: null }).embeds[0];
    expect(embed.title).toContain('Site back up');
    expect(embed.color).toBe(0x22c55e);
  });
});

describe('runScheduledChecks', () => {
  afterEach(() => vi.unstubAllGlobals());

  type Stmt = { sql: string; args: unknown[] };
  /** DB stub: the first batch() is the [settings, monitors] read, the second the writes. */
  function db(monitors: Monitor[], settingsRows: { key: string; value: string }[], updateChanges: number[]) {
    const prepare = (sql: string) => {
      const s: Stmt & { bind: (...a: unknown[]) => Stmt } = { sql, args: [], bind: (...a) => ((s.args = a), s) };
      return s;
    };
    const batch = vi
      .fn()
      .mockResolvedValueOnce([{ results: settingsRows }, { results: monitors }])
      .mockImplementationOnce(async (statements: Stmt[]) => {
        let u = 0;
        return statements.map((s) => ({
          meta: { changes: /^\s*UPDATE monitors/.test(s.sql) ? updateChanges[u++] : 1 },
        }));
      });
    const writes = () => (batch.mock.calls[1]?.[0] ?? []) as Stmt[];
    return { env: { DB: { prepare, batch } } as unknown as Env, batch, writes };
  }
  const kind = (s: Stmt) => s.sql.trim().split(/\s+/).slice(0, 3).join(' ');

  it('alerts on a status change, but not for a monitor paused mid-check', async () => {
    const hook = 'https://discord.com/api/webhooks/1/x';
    // Both already failed once, so this failure confirms the outage.
    const monitors = [
      monitor({ id: 1, url: 'https://a.example', status: 'UP', fail_streak: 1, last_checked_at: null, discord_webhook: hook }),
      monitor({ id: 2, url: 'https://b.example', status: 'UP', fail_streak: 1, last_checked_at: null, discord_webhook: hook }),
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input).startsWith('https://discord.com') ? new Response(null, { status: 204 }) : new Response('down', { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    // Monitor 2's UPDATE changed nothing (paused while being checked).
    const { env, batch, writes } = db(monitors, [], [1, 0]);

    const results = await runScheduledChecks(env, NOW);

    expect(results).toHaveLength(2);
    expect(batch).toHaveBeenCalledTimes(2);
    // per result: open incident, ping, monitor update, hourly stat
    expect(writes().map(kind)).toEqual([
      'INSERT INTO incidents',
      'INSERT INTO pings',
      'UPDATE monitors SET',
      'INSERT INTO ping_stats_hourly',
      'INSERT INTO incidents',
      'INSERT INTO pings',
      'UPDATE monitors SET',
      'INSERT INTO ping_stats_hourly',
    ]);
    const discordCalls = fetchMock.mock.calls.filter(([u]) => String(u).startsWith('https://discord.com'));
    expect(discordCalls).toHaveLength(1);
    expect(JSON.parse(String(discordCalls[0][1]?.body)).embeds[0].title).toContain('Site down');
  });

  it('opens an incident only on the way down and closes it on recovery', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('down') ? new Response('x', { status: 503 }) : new Response('ok', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const monitors = [
      monitor({ id: 1, url: 'https://still-down.example', status: 'DOWN', last_checked_at: null }),
      monitor({ id: 2, url: 'https://recovered.example', status: 'DOWN', last_checked_at: null }),
      monitor({ id: 3, url: 'https://went-down.example', status: 'UP', fail_streak: 1, last_checked_at: NOW - 60_000 }),
      monitor({ id: 4, url: 'https://stays-up.example', status: 'UP', last_checked_at: null }),
      monitor({ id: 5, url: 'https://blip-down.example', status: 'UP', last_checked_at: null }),
    ];
    const { env, writes } = db(monitors, [], [1, 1, 1, 1, 1]);
    await runScheduledChecks(env, NOW);

    const incidentOps = writes().filter((s) => s.sql.includes('incidents'));
    // Monitor 3 is confirming a failure, so it was checked (and written) first.
    expect(incidentOps.map((s) => [kind(s), s.args[0]])).toEqual([
      ['INSERT INTO incidents', 3], // confirmed down: open, with the cause
      ['UPDATE incidents SET', 2], // recovered: close
    ]);
    // The outage started at the first failed check, not the confirming one.
    expect(incidentOps[0].args.slice(1)).toEqual([NOW - 60_000, 'HTTP 503']);

    // The first failure only bumps the streak: still UP, no incident.
    const blip = writes().find((s) => kind(s) === 'UPDATE monitors SET' && s.args[4] === 5);
    expect(blip?.args.slice(0, 2)).toEqual(['UP', 1]);
  });

  describe('free-tier subrequest budget (50 per cron run)', () => {
    /**
     * Worst case on purpose: every site redirects 3 times and then fails, every monitor flips
     * UP → DOWN at once, and every monitor alerts on both Discord and Telegram.
     */
    function worstCase(count: number) {
      const monitors = Array.from({ length: count }, (_, i) =>
        monitor({
          id: i + 1,
          url: `https://site${i + 1}.example`,
          status: 'UP',
          fail_streak: 1,
          last_checked_at: null,
          discord_webhook: 'https://discord.com/api/webhooks/1/x',
          telegram_chat_id: '123456789',
        }),
      );
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('https://discord.com')) return new Response(null, { status: 204 });
        if (url.startsWith('https://api.telegram.org')) return Response.json({ ok: true });
        const hops = (url.match(/\/r/g) ?? []).length;
        return hops < MAX_REDIRECTS ? redirect(`${url}/r`) : new Response('down', { status: 503 });
      });
      vi.stubGlobal('fetch', fetchMock);
      const stub = db(monitors, [], Array(count).fill(1));
      const PRUNE_D1_CALLS = 2; // the hourly prune runs in the same invocation
      const total = () => fetchMock.mock.calls.length + stub.batch.mock.calls.length + PRUNE_D1_CALLS;
      const alerts = () => fetchMock.mock.calls.filter(([u]) => /discord\.com|api\.telegram\.org/.test(String(u))).length;
      const env = { ...stub.env, TELEGRAM_BOT_TOKEN: '123456789:AAEexampleexampleexampleexample12345' } as Env;
      return { env, total, alerts };
    }

    it('the documented worst case fits every plan', () => {
      expect(worstCaseSubrequests(PLAN_LIMITS.free.maxChecksPerMinute)).toBeLessThanOrEqual(PLAN_LIMITS.free.subrequestsPerRun);
      expect(worstCaseSubrequests(PLAN_LIMITS.paid.maxChecksPerMinute)).toBeLessThanOrEqual(PLAN_LIMITS.paid.subrequestsPerRun);
    });

    it('a real worst-case run stays under 50 and still sends every alert', async () => {
      const { env, total, alerts } = worstCase(12); // more due than the free capacity allows
      const results = await runScheduledChecks(env, NOW);
      expect(results).toHaveLength(PLAN_LIMITS.free.maxChecksPerMinute); // 7
      expect(alerts()).toBe(7 * 2);
      expect(total()).toBeLessThanOrEqual(50);
    });

    it('drops alerts rather than exceed a tighter budget', async () => {
      const { env, total } = worstCase(7);
      await runScheduledChecks(env, NOW, 20);
      expect(total()).toBeLessThanOrEqual(20);
    });
  });

  it('checks no more monitors per run than the configured capacity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const monitors = Array.from({ length: 10 }, (_, i) => monitor({ id: i + 1, last_checked_at: null }));
    const { env } = db(monitors, [{ key: 'checksPerMinute', value: '3' }], Array(10).fill(1));
    expect(await runScheduledChecks(env, NOW)).toHaveLength(3);
  });
});
