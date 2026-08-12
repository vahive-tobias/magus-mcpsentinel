import type { ChangeNotice, ChangeNoticeRecord, CheckStatus, DeliveryState, PendingAnalysis, StoredReportRecord, WatchTargetInput, WatchTargetRecord } from "./types.js";

export class WatchRepository {
  public constructor(private readonly db: D1Database) {}

  async createTarget(input: WatchTargetInput): Promise<WatchTargetRecord> {
    const now = new Date().toISOString();
    const target: WatchTargetRecord = {
      id: crypto.randomUUID(),
      account_id: input.accountId,
      package_name: input.packageName,
      package_spec: input.packageSpec ?? "latest",
      enabled: 1,
      baseline_report_id: null,
      last_seen_version: null,
      created_at: now,
      updated_at: now
    };
    await this.db.prepare(
      `INSERT INTO watch_targets (id, account_id, package_name, package_spec, enabled, baseline_report_id, last_seen_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      target.id, target.account_id, target.package_name, target.package_spec, target.enabled,
      target.baseline_report_id, target.last_seen_version, target.created_at, target.updated_at
    ).run();
    return target;
  }

  async listTargets(): Promise<WatchTargetRecord[]> {
    const result = await this.db.prepare("SELECT * FROM watch_targets ORDER BY created_at DESC").all<WatchTargetRecord>();
    return result.results;
  }

  async listEnabledTargets(): Promise<WatchTargetRecord[]> {
    const result = await this.db.prepare("SELECT * FROM watch_targets WHERE enabled = 1 ORDER BY created_at ASC").all<WatchTargetRecord>();
    return result.results;
  }

  async targetById(id: string): Promise<WatchTargetRecord | null> {
    return this.db.prepare("SELECT * FROM watch_targets WHERE id = ?").bind(id).first<WatchTargetRecord>();
  }

  async reportById(id: string): Promise<StoredReportRecord | null> {
    return this.db.prepare("SELECT * FROM analysis_reports WHERE id = ?").bind(id).first<StoredReportRecord>();
  }

  async insertReport(input: Omit<StoredReportRecord, "id" | "received_at">): Promise<{ report: StoredReportRecord; alreadyKnown: boolean }> {
    const existing = await this.db.prepare(
      "SELECT * FROM analysis_reports WHERE target_id = ? AND artifact_sha256 = ?"
    ).bind(input.target_id, input.artifact_sha256).first<StoredReportRecord>();
    if (existing) {
      // The artifact is already on record, but the registry may have published it
      // under a new version number. The watermark tracks the newest version seen,
      // not the newest distinct artifact: without this the scheduled check would
      // resubmit the same target to the analyzer on every run, forever.
      await this.markVersionSeen(input.target_id, input.package_version);
      return { report: existing, alreadyKnown: true };
    }
    const report: StoredReportRecord = { id: crypto.randomUUID(), received_at: new Date().toISOString(), ...input };
    await this.db.prepare(
      `INSERT INTO analysis_reports (id, target_id, artifact_sha256, package_version, report_sha256, report_json, generated_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      report.id, report.target_id, report.artifact_sha256, report.package_version, report.report_sha256,
      report.report_json, report.generated_at, report.received_at
    ).run();
    await this.markVersionSeen(report.target_id, report.package_version);
    return { report, alreadyKnown: false };
  }

  /** Record the newest package version observed for a target. */
  private async markVersionSeen(targetId: string, version: string): Promise<void> {
    await this.db.prepare("UPDATE watch_targets SET last_seen_version = ?, updated_at = ? WHERE id = ?")
      .bind(version, new Date().toISOString(), targetId).run();
  }

  async setBaseline(targetId: string, reportId: string): Promise<void> {
    await this.db.prepare("UPDATE watch_targets SET baseline_report_id = ?, updated_at = ? WHERE id = ?")
      .bind(reportId, new Date().toISOString(), targetId).run();
  }

  async createNotice(targetId: string, baselineReportId: string, candidateReportId: string, notice: ChangeNotice): Promise<ChangeNoticeRecord> {
    const detectedAt = new Date().toISOString();
    const record: ChangeNoticeRecord = {
      id: crypto.randomUUID(),
      target_id: targetId,
      baseline_report_id: baselineReportId,
      candidate_report_id: candidateReportId,
      severity: notice.severity,
      summary: notice.summary,
      changes_json: JSON.stringify(notice.changes),
      state: "pending_review",
      detected_at: detectedAt,
      decided_at: null,
      // The row is inserted undelivered on purpose. Delivery is attempted after
      // it exists, so a notice is never lost because sending failed.
      delivery_state: "pending",
      delivery_attempts: 0,
      delivered_at: null,
      delivery_detail: null
    };
    await this.db.prepare(
      `INSERT INTO change_notices (id, target_id, baseline_report_id, candidate_report_id, severity, summary, changes_json, state, detected_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      record.id, record.target_id, record.baseline_report_id, record.candidate_report_id, record.severity,
      record.summary, record.changes_json, record.state, record.detected_at, record.decided_at
    ).run();
    return record;
  }

  /**
   * Notices that have not reached anyone yet.
   *
   * A notice sitting undelivered is a failure state, so it is retried on every
   * scheduled check rather than being written off after one attempt. The attempt
   * cap stops a permanently misconfigured channel retrying forever; the row keeps
   * its last error either way, so the reason stays visible.
   */
  async listUndeliveredNotices(maxAttempts: number, limit: number): Promise<ChangeNoticeRecord[]> {
    const result = await this.db.prepare(
      `SELECT * FROM change_notices
        WHERE delivery_state IN ('pending', 'failed')
          AND delivery_attempts < ?
        ORDER BY detected_at ASC
        LIMIT ?`
    ).bind(maxAttempts, limit).all<ChangeNoticeRecord>();
    return result.results;
  }

  async recordDelivery(noticeId: string, state: DeliveryState, detail: string): Promise<void> {
    await this.db.prepare(
      `UPDATE change_notices
          SET delivery_state = ?,
              delivery_detail = ?,
              delivery_attempts = delivery_attempts + 1,
              delivered_at = CASE WHEN ? = 'sent' THEN ? ELSE delivered_at END
        WHERE id = ?`
    ).bind(state, detail, state, new Date().toISOString(), noticeId).run();
  }

  async listNotices(): Promise<ChangeNoticeRecord[]> {
    const result = await this.db.prepare(
      "SELECT * FROM change_notices ORDER BY detected_at DESC LIMIT 100"
    ).all<ChangeNoticeRecord>();
    return result.results;
  }

  async noticeById(id: string): Promise<ChangeNoticeRecord | null> {
    return this.db.prepare("SELECT * FROM change_notices WHERE id = ?").bind(id).first<ChangeNoticeRecord>();
  }

  async decideNotice(id: string, state: "accepted" | "frozen" | "ignored"): Promise<ChangeNoticeRecord | null> {
    const notice = await this.db.prepare("SELECT * FROM change_notices WHERE id = ?").bind(id).first<ChangeNoticeRecord>();
    if (!notice) return null;
    const now = new Date().toISOString();
    await this.db.prepare("UPDATE change_notices SET state = ?, decided_at = ? WHERE id = ?").bind(state, now, id).run();
    if (state === "accepted") await this.setBaseline(notice.target_id, notice.candidate_report_id);
    return { ...notice, state, decided_at: now };
  }

  /**
   * Releases detected but not yet analyzed.
   *
   * A target qualifies when its most recent check is still `queued` — the state
   * detect-only mode leaves behind. Reading the latest check rather than any
   * queued check matters: a target that was later analyzed, or that failed for
   * some other reason, must not be handed out again.
   *
   * The absence of a report for that exact version is what actually decides it.
   * Without that clause the same release is handed out on every poll forever,
   * because a report arriving through /api/reports is not itself a check. The
   * status is the hint; the report is the fact.
   */
  async listPendingAnalyses(): Promise<PendingAnalysis[]> {
    const result = await this.db.prepare(
      `SELECT t.id AS target_id, t.package_name, c.observed_version
         FROM watch_targets t
         JOIN check_runs c ON c.id = (
           SELECT id FROM check_runs WHERE target_id = t.id ORDER BY created_at DESC, id DESC LIMIT 1
         )
        WHERE t.enabled = 1
          AND c.status = 'queued'
          AND c.observed_version IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM analysis_reports r
             WHERE r.target_id = t.id AND r.package_version = c.observed_version
          )
        ORDER BY c.created_at ASC`
    ).all<{ target_id: string; package_name: string; observed_version: string }>();
    return result.results.map((row) => ({
      targetId: row.target_id,
      packageName: row.package_name,
      version: row.observed_version
    }));
  }

  /**
   * True when this target already has an outstanding check for this version.
   *
   * Detection runs every few hours, but a release stays outstanding until someone
   * analyzes it. Without this the monitor writes an identical `queued` row on
   * every run for as long as that takes — the same unbounded-redundant-write
   * pattern that has produced real runaway D1 bills elsewhere. One row per
   * outstanding release is all the information there is.
   */
  async hasOpenCheck(targetId: string, version: string): Promise<boolean> {
    const row = await this.db.prepare(
      "SELECT id FROM check_runs WHERE target_id = ? AND status = 'queued' AND observed_version = ? LIMIT 1"
    ).bind(targetId, version).first<{ id: string }>();
    return row !== null;
  }

  async recordCheck(targetId: string, status: CheckStatus, observedVersion?: string, detail?: string): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.prepare(
      "INSERT INTO check_runs (id, target_id, status, observed_version, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, targetId, status, observedVersion ?? null, detail ?? null, new Date().toISOString()).run();
    return id;
  }

  /**
   * Record that analysis is about to start, before any of it runs.
   *
   * A run that exceeds the platform's CPU limit is terminated without reaching any
   * later statement, so a check written only on completion would leave no trace at
   * all. Writing the intent first means an interrupted run is visible as a check
   * still sitting at `queued`, rather than as nothing having happened.
   */
  async beginCheck(targetId: string, observedVersion: string, detail: string): Promise<string> {
    return this.recordCheck(targetId, "queued", observedVersion, detail);
  }

  /**
   * Close out a check that was waiting on a report from elsewhere.
   *
   * Without this the check log shows a release as `queued` forever, even though
   * its report arrived — the state is correct but unreadable to an operator.
   */
  async resolvePendingCheck(targetId: string, version: string, detail: string): Promise<void> {
    await this.db.prepare(
      "UPDATE check_runs SET status = 'analyzed', detail = ? WHERE target_id = ? AND observed_version = ? AND status = 'queued'"
    ).bind(detail, targetId, version).run();
  }

  async completeCheck(checkId: string, status: CheckStatus, detail: string): Promise<void> {
    await this.db.prepare("UPDATE check_runs SET status = ?, detail = ? WHERE id = ?")
      .bind(status, detail, checkId).run();
  }
}
