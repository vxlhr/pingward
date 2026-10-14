-- Capacity model: keep D1 reads/writes inside the free plan.

-- The status index cost an extra row written on every check and saved nothing (≤ 500 monitors).
DROP INDEX IF EXISTS idx_monitors_status;

-- Latest latency lives on the monitor row (written by the same UPDATE, so no extra cost)
-- instead of being looked up from pings on every dashboard load.
ALTER TABLE monitors ADD COLUMN last_response_time_ms INTEGER;

-- Hourly counters for uptime: the dashboard reads ≤ 25 rows per monitor
-- instead of every ping from the last 24 hours. WITHOUT ROWID = one b-tree, one row written.
CREATE TABLE ping_stats_hourly (
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  hour       INTEGER NOT NULL,   -- unix epoch ms, floored to the hour
  checks     INTEGER NOT NULL DEFAULT 0,
  ok         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (monitor_id, hour)
) WITHOUT ROWID;

-- Backfill counters from existing pings.
INSERT INTO ping_stats_hourly (monitor_id, hour, checks, ok)
SELECT monitor_id, (created_at / 3600000) * 3600000, COUNT(*), SUM(ok)
FROM pings GROUP BY monitor_id, (created_at / 3600000);

UPDATE monitors SET last_response_time_ms =
  (SELECT response_time_ms FROM pings p WHERE p.monitor_id = monitors.id ORDER BY created_at DESC LIMIT 1);

-- Admin-editable settings (plan, capacity, retention). Missing keys fall back to defaults.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
