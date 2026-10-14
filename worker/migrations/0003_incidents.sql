-- Incident history: one row per outage, opened on UP/PENDING → DOWN and closed on → UP.
-- Written only on status changes, so it costs almost nothing against the D1 write budget.
CREATE TABLE incidents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,   -- unix epoch ms
  ended_at   INTEGER,            -- NULL = still ongoing
  cause      TEXT                -- first error seen, e.g. "HTTP 503" or "Timeout (10s)"
);

CREATE INDEX idx_incidents_monitor_started ON incidents (monitor_id, started_at DESC);

-- Open an incident for monitors that are already down.
INSERT INTO incidents (monitor_id, started_at, cause)
SELECT id, COALESCE(last_checked_at, created_at), NULL FROM monitors WHERE status = 'DOWN';
