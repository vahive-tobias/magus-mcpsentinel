import assert from "node:assert/strict";
import test from "node:test";
import { WatchRepository } from "../src/repository.js";
import type { StoredReportRecord } from "../src/types.js";

interface Call {
  sql: string;
  args: unknown[];
}

/**
 * Minimal D1 stand-in. It records every prepared statement and its bindings so a
 * test can assert which writes were issued, and returns a caller-supplied row for
 * SELECT statements.
 */
function fakeDatabase(firstRow: (sql: string) => unknown) {
  const calls: Call[] = [];
  const database = {
    prepare(sql: string) {
      const statement = {
        bind(...args: unknown[]) {
          calls.push({ sql, args });
          return statement;
        },
        async first() {
          return firstRow(sql) ?? null;
        },
        async run() {
          return { success: true };
        },
        async all() {
          return { results: [] };
        }
      };
      return statement;
    }
  };
  return { database, calls };
}

function updates(calls: Call[]): Call[] {
  return calls.filter((call) => call.sql.includes("UPDATE watch_targets SET last_seen_version"));
}

const INPUT: Omit<StoredReportRecord, "id" | "received_at"> = {
  target_id: "target-1",
  artifact_sha256: "a".repeat(64),
  package_version: "1.0.1",
  report_sha256: "b".repeat(64),
  report_json: "{}",
  generated_at: "2026-08-04T00:00:00.000Z"
};

test("advances the version watermark when a new artifact is recorded", async () => {
  const { database, calls } = fakeDatabase(() => null);
  const repository = new WatchRepository(database as unknown as D1Database);

  const result = await repository.insertReport(INPUT);

  assert.equal(result.alreadyKnown, false);
  const [update] = updates(calls);
  assert.ok(update, "expected the watermark to be updated");
  assert.equal(update?.args[0], "1.0.1");
  assert.equal(update?.args[2], "target-1");
});

// Regression: npm can publish a new version whose tarball is byte-identical to one
// already on record. If the watermark is not advanced in that case, the scheduled
// check sees an unchanged last_seen_version and resubmits the target to the
// analyzer on every run, forever.
test("advances the version watermark even when the artifact is already known", async () => {
  const known: StoredReportRecord = {
    id: "report-1",
    received_at: "2026-08-01T00:00:00.000Z",
    ...INPUT,
    package_version: "1.0.0"
  };
  const { database, calls } = fakeDatabase((sql) => (sql.includes("SELECT * FROM analysis_reports") ? known : null));
  const repository = new WatchRepository(database as unknown as D1Database);

  const result = await repository.insertReport(INPUT);

  assert.equal(result.alreadyKnown, true);
  assert.equal(result.report.id, "report-1");

  const [update] = updates(calls);
  assert.ok(update, "a known artifact must still advance the watermark");
  assert.equal(update?.args[0], "1.0.1", "watermark must record the newly published version");
  assert.equal(update?.args[2], "target-1");
});

test("does not insert a duplicate report row for a known artifact", async () => {
  const known: StoredReportRecord = { id: "report-1", received_at: "2026-08-01T00:00:00.000Z", ...INPUT };
  const { database, calls } = fakeDatabase((sql) => (sql.includes("SELECT * FROM analysis_reports") ? known : null));
  const repository = new WatchRepository(database as unknown as D1Database);

  await repository.insertReport(INPUT);

  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO analysis_reports")), false);
});
