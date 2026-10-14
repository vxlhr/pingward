import { describe, expect, it } from 'vitest';
import { checkTargetUrl, isDiscordWebhook } from '../src/validation';

describe('checkTargetUrl', () => {
  it.each(['https://example.com', 'http://example.com:8080/health', 'https://8.8.8.8', 'https://api.github.com/status'])(
    'accepts public target %s',
    (url) => expect(checkTargetUrl(url)).toBeNull(),
  );

  it.each([
    'http://localhost',
    'http://app.localhost',
    'http://printer.local',
    'http://db.internal',
    'http://intranet',
    'http://127.0.0.1',
    'http://2130706433', // 127.0.0.1 as a decimal integer
    'http://0x7f000001', // 127.0.0.1 in hex
    'http://10.0.0.5',
    'http://172.20.1.1',
    'http://192.168.0.1',
    'http://169.254.169.254',
    'http://100.64.0.1',
    'http://0.0.0.0',
    'http://[::1]',
    'http://[::ffff:127.0.0.1]',
    'http://[fd00::1]',
    'http://[fe80::1]',
  ])('rejects private/local target %s', (url) => {
    expect(checkTargetUrl(url)).toMatch(/public host/);
  });

  it('rejects credentials embedded in the URL', () => {
    expect(checkTargetUrl('https://user:pass@example.com')).toMatch(/credentials/);
  });

  it.each(['ftp://example.com', 'javascript:alert(1)', 'not a url', 42, null])('rejects non-http value %s', (v) => {
    expect(checkTargetUrl(v)).toMatch(/valid http/);
  });
});

describe('isDiscordWebhook', () => {
  it('accepts Discord webhook URLs', () => {
    expect(isDiscordWebhook('https://discord.com/api/webhooks/123/abc')).toBe(true);
  });

  it.each(['http://discord.com/api/webhooks/1/a', 'https://discord.com.evil.io/api/webhooks/1/a', 'https://discord.com/channels/1'])(
    'rejects %s',
    (url) => expect(isDiscordWebhook(url)).toBe(false),
  );
});
