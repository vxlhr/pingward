import { describe, expect, it } from 'vitest';
import { TELEGRAM_CHAT_ID, buildTelegramMessage, telegramErrorHint } from '../src/telegram';
import type { CheckResult, Monitor } from '../src/types';

const monitor = { id: 1, name: 'Shop <beta> & co', url: 'https://example.com/?a=1&b=2' } as Monitor;
const result = (over: Partial<CheckResult> = {}): CheckResult => ({
  monitor,
  ok: false,
  statusCode: 503,
  responseTimeMs: 120,
  error: 'HTTP 503',
  checkedAt: 0,
  ...over,
});

describe('buildTelegramMessage', () => {
  it('escapes HTML in names, URLs and errors', () => {
    const text = buildTelegramMessage(result({ error: '<script>' }));
    expect(text).toContain('Site down: Shop &lt;beta&gt; &amp; co');
    expect(text).toContain('https://example.com/?a=1&amp;b=2');
    expect(text).toContain('&lt;script&gt;');
    expect(text).not.toContain('<script>');
  });

  it('distinguishes outages from recoveries', () => {
    expect(buildTelegramMessage(result())).toMatch(/^🚨 <b>Site down/);
    expect(buildTelegramMessage(result({ ok: true, statusCode: 200, error: null }))).toMatch(/^✅ <b>Site back up/);
  });
});

describe('telegramErrorHint', () => {
  it.each([
    [401, 'Unauthorized', /bot token is wrong/],
    [400, 'Bad Request: chat not found', /Send any message to the bot first/],
    [403, 'Forbidden: bot was blocked by the user', /blocked the bot/],
    [403, 'Forbidden: bot is not a member of the channel chat', /not allowed to post/],
    [429, 'Too Many Requests', /rate limiting/],
    [403, "Forbidden: the bot can't send messages to the bot", /the bot itself/],
    [403, "Forbidden: bots can't send messages to bots", /the bot itself/],
  ])('%i %s', (status, description, expected) => {
    expect(telegramErrorHint(status, description)).toMatch(expected);
  });
});

describe('TELEGRAM_CHAT_ID', () => {
  it.each(['123456789', '-100123456789', '@pingward_status'])('accepts %s', (id) => expect(TELEGRAM_CHAT_ID.test(id)).toBe(true));
  it.each(['', 'abc', '12 3', '@abc', 'https://t.me/x', '123456789012345678901'])('rejects %s', (id) =>
    expect(TELEGRAM_CHAT_ID.test(id)).toBe(false),
  );
});
