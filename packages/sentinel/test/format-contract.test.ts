import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FORMAT_VERSION, SUPPORTED_FORMATS, assertSentinelReport } from "../src/report-contract.js";
import { validateReport, ReportValidationError } from "../src/schema.js";

/**
 * Three definitions of "which format is this" have to stay in step:
 *
 *   FORMAT_VERSION      what the analyzer writes
 *   report.schema.json  what a generated report is validated against, exactly
 *   SUPPORTED_FORMATS   what a stored report may be, permissively
 *
 * They are deliberately not identical. The schema being stricter is what catches
 * the analyzer emitting a stale format; the read list being wider is what keeps a
 * monitor's older baselines comparable. Both properties are easy to destroy by
 * "fixing" the apparent inconsistency, so they are pinned here.
 */

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../schemas/report.schema.json", import.meta.url)), "utf8")
) as { properties: { format_version: { const?: string } } };

test("the schema pins exactly the version the analyzer writes", () => {
  assert.equal(
    schema.properties.format_version.const,
    FORMAT_VERSION,
    "bumping FORMAT_VERSION without the schema would validate reports against the wrong contract"
  );
});

test("the version the analyzer writes is one it can also read", () => {
  assert.ok(
    SUPPORTED_FORMATS.includes(FORMAT_VERSION),
    "the analyzer must be able to read its own output"
  );
});

// The wider read list is the whole point: a monitor holds baselines written by
// older builds, and dropping one silently discards the history a change notice is
// measured against.
test("older formats stay readable", () => {
  assert.ok(SUPPORTED_FORMATS.length > 1, "narrowing this to one format orphans every stored baseline");
  assert.ok(SUPPORTED_FORMATS.includes("0.1.0"));
});

test("reading is permissive where writing is exact, and that is not a bug", () => {
  const legacy = {
    format_version: "0.1.0",
    report_id: "11111111-1111-4111-8111-111111111111",
    generated_at: "2026-08-09T00:00:00.000Z",
    subject: { server_name: "x", artifact: { ecosystem: "npm", package: "x", version: "1.0.0", sha256: "a".repeat(64), acquired_at: "2026-08-09T00:00:00.000Z" } },
    analysis: {},
    observations: [],
    findings: [],
    limitations: []
  };

  // Read-time: accepted, so an old baseline stays comparable.
  assert.doesNotThrow(() => assertSentinelReport(legacy));

  // Generation-time: refused, so the analyzer cannot ship a stale format.
  return assert.rejects(() => validateReport(legacy), ReportValidationError);
});

test("an unsupported format is refused rather than guessed at", () => {
  assert.throws(
    () => assertSentinelReport({ format_version: "9.9.9", observations: [] }),
    /supported format/i
  );
});
