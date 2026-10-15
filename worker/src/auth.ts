/**
 * Admin-token helpers. They live outside index.ts on purpose: the Worker entry module may only
 * export handlers, and workerd refuses to start if it exports plain values (numbers, strings).
 */

/** Characters Hono's bearerAuth accepts in a token (RFC 6750 token68). */
export const VALID_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;

export const MIN_TOKEN_LENGTH = 16;
const PLACEHOLDER_TOKENS = new Set(['change-me', 'changeme', 'your-long-token-here', 'password', 'admin']);

/** Long enough and not an example value copied from the docs. */
export const isStrongToken = (t: string) => t.length >= MIN_TOKEN_LENGTH && !PLACEHOLDER_TOKENS.has(t.toLowerCase());

/** Constant-time string comparison (hash both, compare digests byte by byte). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x);
  const v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}
