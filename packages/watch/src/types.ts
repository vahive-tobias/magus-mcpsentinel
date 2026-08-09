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

/**
 * Whether the notice reached anyone.
 *
 * Deliberately separate from review state: a notice nobody received is not the
 * same as one nobody has decided on. `pending` and `failed` are both retried.
 */
export type DeliveryState = "pending" | "sent" | "failed" | "not_configured";

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
  delivery_state: DeliveryState;
  delivery_attempts: number;
  delivered_at: string | null;
  delivery_detail: string | null;
}

/**
 * What one scheduled check did.
 *
 * `analyzed` is the only status that means a report exists. `failed` covers both
 * an error and an artifact this deployment cannot hold; neither advances the
 * version watermark, so both are retried rather than mistaken for "unchanged".
 */
export type CheckStatus = "queued" | "analyzed" | "skipped" | "failed";

/** A release the monitor detected but has not analyzed. */
export interface PendingAnalysis {
  targetId: string;
  packageName: string;
  version: string;
}

export interface Env {
  DB: D1Database;
  OPERATOR_API_KEY: string;
  /** Signs reports posted to /api/reports by an operator running the CLI by hand. */
  ANALYZER_INGEST_SECRET: string;
  /**
   * Set to "false" on Workers Free, where the 10 ms CPU limit per invocation is
   * far below what analyzing a package costs. The scheduled check then detects
   * releases and records them as awaiting a report posted to /api/reports.
   * Defaults to enabled.
   */
  ANALYZE_IN_WORKER?: string;
  /**
   * Credential for an external analyzer to read pending work from /api/pending.
   *
   * Distinct from OPERATOR_API_KEY, which can also create targets and decide
   * notices — a runner needs neither. When unset the endpoint does not exist at
   * all, so a deployment that is not running a external analyzer exposes no
   * extra surface.
   */
  ANALYZER_POLL_KEY?: string;
  /**
   * Email delivery, via Resend. All three are required together; with any of them
   * missing a notice is recorded as `not_configured` rather than silently unsent.
   */
  RESEND_API_KEY?: string;
  NOTIFY_FROM?: string;
  NOTIFY_TO?: string;
  /** Overrides the Resend endpoint. Exists so delivery can be exercised against a stub. */
  RESEND_ENDPOINT?: string;
}
