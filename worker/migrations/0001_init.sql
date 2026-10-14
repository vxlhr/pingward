-- PingPulse initial schema.
-- Applied by `npm run db:init` (local) / `npm run db:init:remote`.
-- Wrangler records applied migrations, so re-running never touches existing data.
-- Schema changes go in a new numbered file (0002_*.sql), never by editing this one.

CREATE TABLE monitors (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  url              TEXT    NOT NULL,
  name             TEXT    NOT NULL,
  interval_minutes INTEGER NOT NULL DEFAULT 5 CHECK (interval_minutes BETWEEN 1 AND 1440),
  status           TEXT    NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'UP', 'DOWN', 'PAUSED')),
  last_checked_at  INTEGER,            -- unix epoch (ms)
  discord_webhook  TEXT,
  user_id          TEXT,               -- reserved for multi-user support
  created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE pings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id       INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  status_code      INTEGER,            -- NULL = network error / timeout
  response_time_ms INTEGER NOT NULL,
  ok               INTEGER NOT NULL,   -- 1 = UP, 0 = DOWN
  error            TEXT,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX idx_pings_monitor_created ON pings (monitor_id, created_at DESC);
CREATE INDEX idx_monitors_status ON monitors (status);
