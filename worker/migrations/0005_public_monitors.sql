-- Per-monitor visibility: private monitors are checked and alert as usual, but only
-- signed-in admins see them. Existing monitors stay public (the previous behaviour).
ALTER TABLE monitors ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1;
