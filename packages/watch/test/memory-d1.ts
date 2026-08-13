import type { ChangeNoticeRecord, WatchTargetRecord } from "../src/types.js";

/**
 * An in-memory D1 that actually stores what it is told.
 *
 * The route tests stub `prepare` to return fixed rows, which is right for
 * asserting what a handler *did*. It cannot answer an ordering question: whether
 * accepting five notices in some sequence lands on the same baseline requires the
 * store to remember the four accepts that came before. A fixture that cannot model
 * its own writes passes while asserting nothing — that already happened once here.
 *
 * Matching is by SQL shape rather than by parsing SQL. That is a real limit: a
 * statement whose text changes stops being recognised, and the test fails loudly
 * rather than silently answering wrong. Every statement this recognises is one the
 * enumerations actually drive.
 */

export interface ReportRow {
  id: string;
  target_id: string;
  package_version: string;
  received_at: string;
  report_json?: string;
  artifact_sha256?: string;
  report_sha256?: string;
  generated_at?: string;
}

export interface MemoryDatabase {
  db: D1Database;
  targets: WatchTargetRecord[];
  notices: ChangeNoticeRecord[];
  reports: ReportRow[];
  /** Every statement run, in order, for asserting what was written. */
  executed: { sql: string; parameters: unknown[] }[];
}

export function memoryDatabase(seed: {
  targets?: WatchTargetRecord[];
  notices?: ChangeNoticeRecord[];
  reports?: ReportRow[];
} = {}): MemoryDatabase {
  const state: MemoryDatabase = {
    db: undefined as unknown as D1Database,
    targets: seed.targets ?? [],
    notices: seed.notices ?? [],
    reports: seed.reports ?? [],
    executed: []
  };

  const run = (sql: string, parameters: unknown[]): unknown => {
    state.executed.push({ sql, parameters });
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (/^SELECT \* FROM change_notices WHERE id = \?/.test(normalized)) {
      return state.notices.find((notice) => notice.id === parameters[0]) ?? null;
    }
    if (/^SELECT \* FROM watch_targets WHERE id = \?/.test(normalized)) {
      return state.targets.find((target) => target.id === parameters[0]) ?? null;
    }
    if (/^SELECT received_at FROM analysis_reports WHERE id = \?/.test(normalized)) {
      const report = state.reports.find((row) => row.id === parameters[0]);
      return report ? { received_at: report.received_at } : null;
    }
    if (/^SELECT \* FROM analysis_reports WHERE id = \?/.test(normalized)) {
      return state.reports.find((row) => row.id === parameters[0]) ?? null;
    }
    if (/^SELECT \* FROM change_notices ORDER BY/.test(normalized)) {
      return { results: [...state.notices] };
    }
    if (/^UPDATE change_notices SET state = \?, decided_at = \? WHERE id = \?/.test(normalized)) {
      const notice = state.notices.find((row) => row.id === parameters[2]);
      if (notice) {
        notice.state = parameters[0] as ChangeNoticeRecord["state"];
        notice.decided_at = parameters[1] as string;
      }
      return { success: true };
    }
    if (/^UPDATE watch_targets SET baseline_report_id = \?, updated_at = \? WHERE id = \?/.test(normalized)) {
      const target = state.targets.find((row) => row.id === parameters[2]);
      if (target) {
        target.baseline_report_id = parameters[0] as string;
        target.updated_at = parameters[1] as string;
      }
      return { success: true };
    }

    throw new Error(`memory-d1 does not recognise this statement: ${normalized}`);
  };

  state.db = {
    prepare(sql: string) {
      let parameters: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { parameters = values; return statement; },
        async first() {
          const result = run(sql, parameters);
          return result && typeof result === "object" && "results" in result ? null : result;
        },
        async all() {
          const result = run(sql, parameters);
          return result && typeof result === "object" && "results" in result ? result : { results: [] };
        },
        async run() { return run(sql, parameters); }
      };
      return statement;
    }
  } as unknown as D1Database;

  return state;
}

export function target(overrides: Partial<WatchTargetRecord> = {}): WatchTargetRecord {
  return {
    id: "t1",
    account_id: "a1",
    package_name: "@scope/example-mcp",
    package_spec: "latest",
    enabled: 1,
    baseline_report_id: "r0",
    last_seen_version: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides
  };
}

export function notice(overrides: Partial<ChangeNoticeRecord> = {}): ChangeNoticeRecord {
  return {
    id: "n1",
    target_id: "t1",
    baseline_report_id: "r0",
    candidate_report_id: "r1",
    severity: "review",
    summary: "summary",
    changes_json: "[]",
    state: "pending_review",
    detected_at: "2026-08-08T00:00:00.000Z",
    decided_at: null,
    delivery_state: "sent",
    delivery_attempts: 1,
    delivered_at: "2026-08-08T00:00:01.000Z",
    delivery_detail: null,
    ...overrides
  };
}
