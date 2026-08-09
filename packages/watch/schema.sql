-- MAGUS MCP Watch v0.1 D1 schema
-- Public npm package sources only. No customer credentials are stored.
--
-- This creates a database. It does not migrate one. `CREATE TABLE IF NOT EXISTS`
-- is a no-op against a table that already exists, so a column added here never
-- reaches a deployed database by re-running this file — the run fails on the
-- first index that references the new column, which is confusing rather than
-- informative. After the first deployment, a schema change needs an explicit
-- ALTER TABLE run against that database, or a fresh one.

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'community' CHECK (plan IN ('community', 'builder', 'studio')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watch_targets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  package_name TEXT NOT NULL,
  package_spec TEXT NOT NULL DEFAULT 'latest',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  baseline_report_id TEXT,
  last_seen_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, package_name)
);

CREATE TABLE IF NOT EXISTS analysis_reports (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES watch_targets(id),
  artifact_sha256 TEXT NOT NULL,
  package_version TEXT NOT NULL,
  report_sha256 TEXT NOT NULL,
  report_json TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE(target_id, artifact_sha256)
);

CREATE TABLE IF NOT EXISTS change_notices (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES watch_targets(id),
  baseline_report_id TEXT NOT NULL REFERENCES analysis_reports(id),
  candidate_report_id TEXT NOT NULL REFERENCES analysis_reports(id),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'review', 'high')),
  summary TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending_review' CHECK (state IN ('pending_review', 'accepted', 'frozen', 'ignored')),
  detected_at TEXT NOT NULL,
  decided_at TEXT,
  -- Delivery is tracked separately from review, because a notice nobody received
  -- is not the same as one nobody has decided on yet. `pending` and `failed` are
  -- both retried; `not_configured` records that no channel was set up, so an
  -- undelivered notice is never mistaken for a delivered one.
  delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending', 'sent', 'failed', 'not_configured')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  delivery_detail TEXT,
  UNIQUE(target_id, candidate_report_id)
);

-- `analyzed` is the only status that means a report was produced. `failed` covers
-- both an error and an artifact too large for this deployment to hold; neither
-- advances watch_targets.last_seen_version, so neither can be read as "unchanged".
CREATE TABLE IF NOT EXISTS check_runs (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES watch_targets(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'analyzed', 'skipped', 'failed')),
  observed_version TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_watch_targets_enabled ON watch_targets(enabled);
CREATE INDEX IF NOT EXISTS idx_reports_target_received ON analysis_reports(target_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_notices_target_detected ON change_notices(target_id, detected_at DESC);

-- check_runs is the only table that grows without bound: one row per target per
-- scheduled check, forever. D1 bills rows *scanned*, not rows returned, so a
-- query here without a usable index costs the whole table every time it runs.
--
-- Measured before adding these, against two years of six-hourly checks on 25
-- targets (73,000 rows): finding each target's latest check scanned 1,825,000
-- rows per call, because the lookup ran once per target. That alone exceeds a
-- free-tier daily read allowance in a few polls, and grows for as long as the
-- monitor keeps running.
--
-- The first index serves "the latest check for this target"; the second serves
-- resolving an outstanding check when its report arrives. Both turn a full scan
-- into a seek.
-- `id` is in the index because it is the tiebreaker when two checks share a
-- timestamp; without it the lookup still needs a sort to pick the latest.
CREATE INDEX IF NOT EXISTS idx_check_runs_target_created ON check_runs(target_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_check_runs_target_status_version ON check_runs(target_id, status, observed_version);
CREATE INDEX IF NOT EXISTS idx_check_runs_created ON check_runs(created_at);

-- Retrying undelivered notices runs on every scheduled check, so it must be a
-- seek. Partial, because the rows it looks for are the rare ones: almost every
-- notice ends up 'sent', and those are exactly the rows worth not indexing.
CREATE INDEX IF NOT EXISTS idx_notices_undelivered ON change_notices(delivery_state, detected_at)
  WHERE delivery_state IN ('pending', 'failed');

-- The dashboard's most-recent-first listing. Without this it sorts the whole
-- table on every load, which is cheap today and grows with every change found.
CREATE INDEX IF NOT EXISTS idx_notices_detected ON change_notices(detected_at DESC);
