import assert from "node:assert/strict";
import test from "node:test";
import { diffReports, snapshotFromReport, type ChangeKind } from "../src/diff.js";
import { FORMAT_VERSION, OBSERVATION_IDS, OBSERVATION_KINDS, type ReportObservation, type SentinelReport } from "../src/report-contract.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

interface ToolFixture {
  name: string;
  description_sha256?: string;
  input_schema_sha256?: string;
  input_schema_properties?: string[];
}

interface Options {
  version: string;
  sha256: string;
  dependencies?: Record<string, string>;
  indicators?: string[];
  tools?: ToolFixture[];
  toolsComplete?: boolean;
  toolsIncompleteness?: string[];
  metadata?: Record<string, unknown>;
  files?: string[];
}

function report(options: Options): SentinelReport {
  const observations: ReportObservation[] = [
    {
      id: OBSERVATION_IDS.runtimeDependencies,
      kind: OBSERVATION_KINDS.dependency,
      coverage: "declared",
      data: { dependencies: options.dependencies ?? {} }
    },
    ...(options.indicators ?? []).map((indicator, index) => ({
      id: `observation:indicator-${index}`,
      kind: OBSERVATION_KINDS.codeIndicator,
      coverage: "inferred",
      data: { indicator }
    }))
  ];

  if (options.metadata) {
    observations.push({
      id: OBSERVATION_IDS.packageMetadata,
      kind: OBSERVATION_KINDS.artifactMetadata,
      coverage: "declared",
      data: { name: "example-mcp", version: options.version, ...options.metadata }
    });
  }
  if (options.files) {
    observations.push({
      id: OBSERVATION_IDS.fileInventory,
      kind: OBSERVATION_KINDS.file,
      coverage: "declared",
      data: { entries: options.files.map((path) => ({ path, type: "file" })) }
    });
  }
  if (options.tools) {
    observations.push({
      id: OBSERVATION_IDS.staticToolInventory,
      kind: OBSERVATION_KINDS.protocolInventory,
      coverage: "inferred",
      data: { complete: options.toolsComplete ?? true, incompleteness: options.toolsIncompleteness ?? [], tools: options.tools }
    });
  }

  return {
    format_version: FORMAT_VERSION,
    report_id: "11111111-1111-4111-8111-111111111111",
    generated_at: "2026-08-04T00:00:00.000Z",
    subject: {
      server_name: "example-mcp",
      artifact: {
        ecosystem: "npm",
        package: "example-mcp",
        version: options.version,
        sha256: options.sha256,
        acquired_at: "2026-08-04T00:00:00.000Z"
      }
    },
    observations,
    findings: [],
    limitations: []
  };
}

function kinds(changes: Array<{ kind: ChangeKind }>): ChangeKind[] {
  return changes.map((change) => change.kind).sort();
}

test("normalizes dependencies and indicators", () => {
  const snapshot = snapshotFromReport(report({
    version: "1.0.0",
    sha256: HASH_A,
    dependencies: { zed: "1.0.0", alpha: "2.0.0" },
    indicators: ["filesystem-api"]
  }));
  assert.deepEqual(snapshot.dependencies, { alpha: "2.0.0", zed: "1.0.0" });
  assert.deepEqual([...snapshot.indicators], ["filesystem-api"]);
});

test("refuses to compare different package identities", () => {
  const baseline = report({ version: "1.0.0", sha256: HASH_A });
  const candidate = report({ version: "1.1.0", sha256: HASH_B });
  candidate.subject.artifact.package = "different-mcp";
  assert.throws(() => diffReports(baseline, candidate), /different npm package/);
});

// The headline case from docs/FIXTURE_PLAN.md: v2 adds a tool and changes a schema.
test("lineage v1 to v2: reports exactly the added tool and the changed schema", () => {
  const baseline = report({
    version: "1.0.0",
    sha256: HASH_A,
    tools: [{ name: "read_file", description_sha256: "d1", input_schema_sha256: "s1", input_schema_properties: ["path"] }]
  });
  const candidate = report({
    version: "2.0.0",
    sha256: HASH_B,
    tools: [
      { name: "read_file", description_sha256: "d1", input_schema_sha256: "s2", input_schema_properties: ["path", "encoding"] },
      { name: "delete_file", description_sha256: "d3", input_schema_sha256: "s3", input_schema_properties: ["path"] }
    ]
  });

  const result = diffReports(baseline, candidate);
  assert.deepEqual(kinds(result.changes), ["artifact_changed", "tool_added", "tool_schema_changed"]);
  assert.equal(result.limited, false);

  const schema = result.changes.find((change) => change.kind === "tool_schema_changed");
  assert.deepEqual(schema?.detail?.addedProperties, ["encoding"]);
});

// The diff states facts. Ranking them is the consumer's job.
test("emits no severity of any kind", () => {
  const baseline = report({ version: "1.0.0", sha256: HASH_A, tools: [] });
  const candidate = report({ version: "1.1.0", sha256: HASH_B, tools: [{ name: "new_tool" }], metadata: { scripts: { postinstall: "x" } } });
  const serialized = JSON.stringify(diffReports(baseline, candidate));
  assert.equal(serialized.includes("severity"), false);
  assert.equal(/"(high|review|critical)"/.test(serialized), false);
});

test("does not invent tool changes when one side has no inventory", () => {
  const baseline = report({ version: "1.0.0", sha256: HASH_A });
  const candidate = report({ version: "1.1.0", sha256: HASH_B, tools: [{ name: "alpha" }, { name: "beta" }] });

  const result = diffReports(baseline, candidate);
  assert.equal(result.changes.some((change) => change.kind === "tool_added"), false);
  assert.equal(result.limited, true);
  assert.equal(result.changes.find((c) => c.kind === "comparison_limited")?.detail?.reason, "missing_inventory");
});

test("treats a missing tool as inconclusive when extraction was incomplete", () => {
  const baseline = report({ version: "1.0.0", sha256: HASH_A, tools: [{ name: "alpha" }, { name: "beta" }], toolsComplete: true });
  const candidate = report({ version: "1.1.0", sha256: HASH_B, tools: [{ name: "alpha" }], toolsComplete: false });

  const result = diffReports(baseline, candidate);
  assert.equal(result.changes.some((change) => change.kind === "tool_removed"), false);
  assert.equal(result.limited, true);
});

test("a surface that could be read and now cannot is reported, with the reason", () => {
  const baseline = report({ version: "1.0.0", sha256: HASH_A, tools: [{ name: "alpha" }], toolsComplete: true });
  const candidate = report({
    version: "1.1.0", sha256: HASH_B, tools: [{ name: "alpha" }],
    toolsComplete: false, toolsIncompleteness: ["source_file_exceeded_parse_size_limit"]
  });

  const change = diffReports(baseline, candidate).changes.find((c) => c.kind === "coverage_regressed");
  assert.ok(change, "a complete-to-incomplete transition should be reported");
  assert.deepEqual(change.detail?.reasons, ["source_file_exceeded_parse_size_limit"]);
});

// The distinction the diff used to collapse: both of these emit `comparison_limited`,
// and only the transition above is a change in the package.
test("a surface that was never complete has not regressed", () => {
  const baseline = report({ version: "1.0.0", sha256: HASH_A, tools: [{ name: "alpha" }], toolsComplete: false });
  const candidate = report({ version: "1.1.0", sha256: HASH_B, tools: [{ name: "alpha" }], toolsComplete: false });

  const result = diffReports(baseline, candidate);
  assert.equal(result.changes.some((c) => c.kind === "coverage_regressed"), false);
  assert.equal(result.changes.some((c) => c.kind === "comparison_limited"), true);
});

test("extraction that stayed complete, or recovered, is not a regression", () => {
  const complete = report({ version: "1.0.0", sha256: HASH_A, tools: [{ name: "alpha" }], toolsComplete: true });
  const recovered = report({ version: "1.1.0", sha256: HASH_B, tools: [{ name: "alpha" }], toolsComplete: true });
  const partial = report({ version: "0.9.0", sha256: HASH_A, tools: [{ name: "alpha" }], toolsComplete: false });

  for (const [baseline, candidate] of [[complete, recovered], [partial, recovered]] as const) {
    const result = diffReports(baseline, candidate);
    assert.equal(result.changes.some((c) => c.kind === "coverage_regressed"), false);
  }
});

test("a regression with no reason recorded is still reported", () => {
  const baseline = report({ version: "1.0.0", sha256: HASH_A, tools: [{ name: "alpha" }], toolsComplete: true });
  const candidate = report({ version: "1.1.0", sha256: HASH_B, tools: [{ name: "alpha" }], toolsComplete: false, toolsIncompleteness: [] });

  const change = diffReports(baseline, candidate).changes.find((c) => c.kind === "coverage_regressed");
  assert.ok(change, "an unrecorded reason must not suppress the finding");
  assert.deepEqual(change.detail?.reasons, []);
});

test("a missing inventory is still not a coverage regression", () => {
  const baseline = report({ version: "1.0.0", sha256: HASH_A });
  const candidate = report({ version: "1.1.0", sha256: HASH_B, tools: [{ name: "alpha" }], toolsComplete: false });

  const result = diffReports(baseline, candidate);
  assert.equal(result.changes.some((c) => c.kind === "coverage_regressed"), false);
  assert.equal(result.changes.find((c) => c.kind === "comparison_limited")?.detail?.reason, "missing_inventory");
});

test("reports a real removal when both extractions are complete", () => {
  const baseline = report({ version: "1.0.0", sha256: HASH_A, tools: [{ name: "alpha" }, { name: "beta" }] });
  const candidate = report({ version: "1.1.0", sha256: HASH_B, tools: [{ name: "alpha" }] });

  const result = diffReports(baseline, candidate);
  assert.equal(result.changes.find((c) => c.kind === "tool_removed")?.detail?.tool, "beta");
});

test("distinguishes install-time scripts from ordinary scripts", () => {
  const baseline = report({ version: "1.0.0", sha256: HASH_A, tools: [], metadata: { scripts: {} } });
  const candidate = report({ version: "1.1.0", sha256: HASH_B, tools: [], metadata: { scripts: { postinstall: "node s.js", build: "tsc" } } });

  const result = diffReports(baseline, candidate);
  assert.equal(result.changes.find((c) => c.kind === "install_script_changed")?.detail?.script, "postinstall");
  assert.equal(result.changes.find((c) => c.kind === "script_changed")?.detail?.script, "build");
});

test("reports a changed entrypoint", () => {
  const baseline = report({ version: "1.0.0", sha256: HASH_A, tools: [], metadata: { bin: { demo: "./cli.js" } } });
  const candidate = report({ version: "1.1.0", sha256: HASH_B, tools: [], metadata: { bin: { demo: "./other.js" } } });
  assert.equal(diffReports(baseline, candidate).changes.some((c) => c.kind === "entrypoint_changed"), true);
});

test("ignores the version bump itself", () => {
  const baseline = report({ version: "1.0.0", sha256: HASH_A, tools: [], metadata: { description: "Same" } });
  const candidate = report({ version: "2.0.0", sha256: HASH_B, tools: [], metadata: { description: "Same" } });
  assert.deepEqual(kinds(diffReports(baseline, candidate).changes), ["artifact_changed"]);
});

test("summarizes file inventory changes into a single entry", () => {
  const baseline = report({ version: "1.0.0", sha256: HASH_A, tools: [], files: ["package/a.js", "package/b.js"] });
  const candidate = report({ version: "1.1.0", sha256: HASH_B, tools: [], files: ["package/a.js", "package/c.js"] });

  const changes = diffReports(baseline, candidate).changes.filter((c) => c.kind === "file_inventory_changed");
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0]?.detail?.added, ["package/c.js"]);
  assert.deepEqual(changes[0]?.detail?.removed, ["package/b.js"]);
});

test("an identical rebuild produces no changes", () => {
  const options = {
    version: "1.0.0",
    sha256: HASH_A,
    dependencies: { alpha: "1.0.0" },
    tools: [{ name: "t", description_sha256: "d1", input_schema_sha256: "s1" }],
    metadata: { description: "Same", bin: { demo: "./cli.js" } },
    files: ["package/a.js"]
  };
  const result = diffReports(report(options), report(options));
  assert.deepEqual(result.changes, []);
  assert.equal(result.limited, false);
});

test("accepts a 0.1.0 report so existing baselines stay comparable", () => {
  const legacy = report({ version: "1.0.0", sha256: HASH_A });
  legacy.format_version = "0.1.0";
  assert.doesNotThrow(() => snapshotFromReport(legacy));
});

test("rejects an unknown format version rather than guessing", () => {
  const future = report({ version: "1.0.0", sha256: HASH_A });
  future.format_version = "9.9.9";
  assert.throws(() => snapshotFromReport(future), /supported format/);
});
