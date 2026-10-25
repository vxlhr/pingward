-- Fewer false alarms, content checks, maintenance windows and a public status page.

-- Failed checks in a row. A monitor only turns DOWN (incident + alert) once this reaches 2;
-- after the first failure it is re-checked a minute later instead of waiting a full interval.
ALTER TABLE monitors ADD COLUMN fail_streak INTEGER NOT NULL DEFAULT 0;

-- Optional content checks. NULL = defaults (any 2xx is UP, the body isn't read).
--   accepted_status: e.g. "200-299,401"  (applied to the final response, after redirects)
--   keyword:         text that must appear in the first 64 KB of the body (case-sensitive)
ALTER TABLE monitors ADD COLUMN accepted_status TEXT;
ALTER TABLE monitors ADD COLUMN keyword TEXT;

-- Maintenance window: until this time (unix ms) the monitor isn't checked, so it neither
-- alerts nor counts against its uptime. NULL = no maintenance.
ALTER TABLE monitors ADD COLUMN maintenance_until INTEGER;

-- Average response time per hour for the longer chart ranges (same row, no extra write).
ALTER TABLE ping_stats_hourly ADD COLUMN response_ms_sum INTEGER NOT NULL DEFAULT 0;

-- Daily counters for the 90-day bars on the status page. Rolled up from the hourly counters
-- once an hour (by the prune job), so checks don't write anything extra.
CREATE TABLE ping_stats_daily (
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  day        INTEGER NOT NULL,   -- unix epoch ms, floored to the UTC day
  checks     INTEGER NOT NULL DEFAULT 0,
  ok         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (monitor_id, day)
) WITHOUT ROWID;

INSERT INTO ping_stats_daily (monitor_id, day, checks, ok)
SELECT monitor_id, (hour / 86400000) * 86400000, SUM(checks), SUM(ok)
FROM ping_stats_hourly GROUP BY monitor_id, (hour / 86400000);

-- Rough response-time backfill from the raw pings that are still kept.
UPDATE ping_stats_hourly SET response_ms_sum = COALESCE((
  SELECT SUM(response_time_ms) FROM pings p
  WHERE p.monitor_id = ping_stats_hourly.monitor_id
    AND p.created_at >= ping_stats_hourly.hour AND p.created_at < ping_stats_hourly.hour + 3600000
), 0);
