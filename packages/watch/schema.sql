-- MAGUS MCP Watch v0.1 D1 schema
-- Public npm package sources only. No customer credentials are stored.

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
