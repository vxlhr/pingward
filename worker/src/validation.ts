/** Input validation for monitor targets and webhooks (pure functions, unit-tested). */

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet'];

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 || // "this" network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast + reserved
  );
}

function isPrivateIPv6(host: string): boolean {
  if (!host.startsWith('[')) return false;
  const ip = host.slice(1, -1).toLowerCase();
  return (
    ip === '::' ||
    ip === '::1' ||
    ip.startsWith('::ffff:') || // IPv4-mapped: could hide a private IPv4
    /^f[cd][0-9a-f]{2}:/.test(ip) || // unique local fc00::/7
    /^fe[89ab][0-9a-f]:/.test(ip) // link-local fe80::/10
  );
}

/**
 * Returns an error message, or null if the URL is an acceptable public http(s) target.
 * The WHATWG URL parser already normalises tricks like http://2130706433 → 127.0.0.1.
 */
export function checkTargetUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return 'url must be a valid http(s) URL';
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return 'url must be a valid http(s) URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'url must be a valid http(s) URL';
  // Reads are public, so never store credentials embedded in a URL.
  if (u.username || u.password) return 'url must not contain credentials';

  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (
    host === 'localhost' ||
    !host.includes('.') && !host.startsWith('[') || // single-label intranet names
    BLOCKED_SUFFIXES.some((s) => host.endsWith(s)) ||
    isPrivateIPv4(host) ||
    isPrivateIPv6(host)
  ) {
    return 'url must point to a public host (private, local and internal addresses are not allowed)';
  }
  return null;
}

export function isDiscordWebhook(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      ['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'].includes(u.hostname) &&
      u.pathname.startsWith('/api/webhooks/')
    );
  } catch {
    return false;
  }
}
