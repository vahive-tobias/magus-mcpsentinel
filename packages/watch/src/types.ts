import type { ChangeKind } from "mcp-sentinel/diff";

/**
 * Watch-specific types.
 *
 * The report contract and the change vocabulary belong to the analyzer and are
 * imported from it — never redeclared here. A hand-copied contract is a contract
 * that drifts silently.
 */

export type { ChangeKind } from "mcp-sentinel/diff";
export type { JsonObject, SentinelReport } from "mcp-sentinel/report-contract";

/** Review urgency. This is Watch's judgement, not the analyzer's. */
export type Severity = "info" | "review" | "high";

export interface WatchChange {
  kind: ChangeKind;
  severity: Severity;
  summary: string;
}

export interface ChangeNotice {
  severity: Severity;
  summary: string;
  changes: WatchChange[];
}

export interface WatchTargetInput {
  accountId: string;
  packageName: string;
  packageSpec?: string;
}

export interface WatchTargetRecord {
  id: string;
  account_id: string;
  package_name: string;
  package_spec: string;
  enabled: number;
  baseline_report_id: string | null;
  last_seen_version: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoredReportRecord {
  id: string;
  target_id: string;
  artifact_sha256: string;
  package_version: string;
  report_sha256: string;
  report_json: string;
  generated_at: string;
  received_at: string;
}

export interface ChangeNoticeRecord {
  id: string;
  target_id: string;
  baseline_report_id: string;
  candidate_report_id: string;
  severity: Severity;
  summary: string;
  changes_json: string;
  state: "pending_review" | "accepted" | "frozen" | "ignored";
  detected_at: string;
  decided_at: string | null;
}

export interface Env {
  DB: D1Database;
  OPERATOR_API_KEY: string;
  ANALYZER_INGEST_SECRET: string;
  JOB_SIGNING_SECRET: string;
  ANALYZER_URL?: string;
}
