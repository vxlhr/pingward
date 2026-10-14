import type { Monitor } from '@pingward/shared';

export type { Incident, Monitor, MonitorStatus, MonitorSummary, Ping } from '@pingward/shared';

export interface Env {
  DB: D1Database;
  /** Static dashboard files (frontend/out), served for every non-/api route. */
  ASSETS: Fetcher;
  /** Per-IP rate limiter for /api/* (optional so unit tests can omit it). */
  API_RATE_LIMITER?: RateLimit;
  /** Comma-separated extra origins allowed to call the API cross-origin (CORS). */
  ALLOWED_ORIGINS?: string;
  /** Bearer token for write endpoints (and reads when READ_PROTECTED is "true"). */
  API_TOKEN?: string;
  /** "true" = reads need the token too (private dashboard). Default: public reads. */
  READ_PROTECTED?: string;
  /**
   * "true" = allow writes when API_TOKEN is unset. Only `npm run dev` sets this;
   * in production a missing token means writes are refused (fail closed).
   */
  ALLOW_UNAUTHENTICATED_WRITES?: string;
  /** Telegram bot token from @BotFather (secret). Unset = Telegram alerts are off. */
  TELEGRAM_BOT_TOKEN?: string;
}

export interface CheckResult {
  monitor: Monitor;
  ok: boolean;
  statusCode: number | null;
  responseTimeMs: number;
  error: string | null;
  checkedAt: number;
}
