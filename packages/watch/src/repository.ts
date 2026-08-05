import type { ChangeNotice, ChangeNoticeRecord, StoredReportRecord, WatchTargetInput, WatchTargetRecord } from "./types.js";

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
      decided_at: null
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

  async listNotices(): Promise<ChangeNoticeRecord[]> {
    const result = await this.db.prepare(
      "SELECT * FROM change_notices ORDER BY detected_at DESC LIMIT 100"
    ).all<ChangeNoticeRecord>();
    return result.results;
  }

  async decideNotice(id: string, state: "accepted" | "frozen" | "ignored"): Promise<ChangeNoticeRecord | null> {
    const notice = await this.db.prepare("SELECT * FROM change_notices WHERE id = ?").bind(id).first<ChangeNoticeRecord>();
    if (!notice) return null;
    const now = new Date().toISOString();
    await this.db.prepare("UPDATE change_notices SET state = ?, decided_at = ? WHERE id = ?").bind(state, now, id).run();
    if (state === "accepted") await this.setBaseline(notice.target_id, notice.candidate_report_id);
    return { ...notice, state, decided_at: now };
  }

  async recordCheck(targetId: string, status: "queued" | "submitted" | "skipped" | "failed", observedVersion?: string, detail?: string): Promise<void> {
    await this.db.prepare(
      "INSERT INTO check_runs (id, target_id, status, observed_version, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), targetId, status, observedVersion ?? null, detail ?? null, new Date().toISOString()).run();
  }
}
