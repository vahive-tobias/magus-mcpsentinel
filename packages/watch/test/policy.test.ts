import assert from "node:assert/strict";
import test from "node:test";
import { FORMAT_VERSION, OBSERVATION_IDS, OBSERVATION_KINDS } from "mcp-sentinel/report-contract";
import type { ReportObservation, SentinelReport } from "mcp-sentinel/report-contract";
import { createChangeNotice } from "../src/policy.js";

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
  metadata?: Record<string, unknown>;
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
  if (options.tools) {
    observations.push({
      id: OBSERVATION_IDS.staticToolInventory,
      kind: OBSERVATION_KINDS.protocolInventory,
      coverage: "inferred",
      data: { complete: options.toolsComplete ?? true, incompleteness: [], tools: options.tools }
    });
  }

  return {
    format_version: FORMAT_VERSION,
    report_id: "11111111-1111-4111-8111-111111111111",
    generated_at: "2026-08-05T00:00:00.000Z",
    subject: {
      server_name: "example-mcp",
      artifact: {
        ecosystem: "npm",
        package: "example-mcp",
        version: options.version,
        sha256: options.sha256,
        acquired_at: "2026-08-05T00:00:00.000Z"
      }
    },
    observations,
    findings: [],
    limitations: []
  };
}

test("a new tool is high severity: the agent gained a capability", () => {
  const baseline = report({ version: "1.0.0", sha256: HASH_A, tools: [{ name: "read" }] });
  const candidate = report({ version: "1.1.0", sha256: HASH_B, tools: [{ name: "read" }, { name: "delete" }] });

  const notice = createChangeNotice(baseline, candidate);
  assert.equal(notice.severity, "high");
  assert.equal(notice.changes.find((c) => c.kind === "tool_added")?.severity, "high");
});

// A widened schema accepts input it previously refused; a narrowed one does not.
test("a widened schema is high, a narrowed schema is review", () => {
  const widened = createChangeNotice(
    report({ version: "1.0.0", sha256: HASH_A, tools: [{ name: "t", input_schema_sha256: "s1", input_schema_properties: ["a"] }] }),
    report({ version: "1.1.0", sha256: HASH_B, tools: [{ name: "t", input_schema_sha256: "s2", input_schema_properties: ["a", "b"] }] })
  );
  assert.equal(widened.changes.find((c) => c.kind === "tool_schema_changed")?.severity, "high");

  const narrowed = createChangeNotice(
    report({ version: "1.0.0", sha256: HASH_A, tools: [{ name: "t", input_schema_sha256: "s1", input_schema_properties: ["a", "b"] }] }),
    report({ version: "1.1.0", sha256: HASH_B, tools: [{ name: "t", input_schema_sha256: "s2", input_schema_properties: ["a"] }] })
  );
  assert.equal(narrowed.changes.find((c) => c.kind === "tool_schema_changed")?.severity, "review");
});

test("an added install-time script is high severity", () => {
  const notice = createChangeNotice(
    report({ version: "1.0.0", sha256: HASH_A, tools: [], metadata: { scripts: {} } }),
    report({ version: "1.1.0", sha256: HASH_B, tools: [], metadata: { scripts: { postinstall: "node s.js" } } })
  );
  assert.equal(notice.changes.find((c) => c.kind === "install_script_changed")?.severity, "high");
});

test("an ordinary build script is only informational", () => {
  const notice = createChangeNotice(
    report({ version: "1.0.0", sha256: HASH_A, tools: [], metadata: { scripts: { build: "tsc" } } }),
    report({ version: "1.1.0", sha256: HASH_B, tools: [], metadata: { scripts: { build: "tsc -p ." } } })
  );
  assert.equal(notice.changes.find((c) => c.kind === "script_changed")?.severity, "info");
});

test("process spawning is high, an ordinary indicator is review", () => {
  const spawn = createChangeNotice(
    report({ version: "1.0.0", sha256: HASH_A, tools: [] }),
    report({ version: "1.1.0", sha256: HASH_B, tools: [], indicators: ["process-spawn-api"] })
  );
  assert.equal(spawn.changes.find((c) => c.kind === "indicator_added")?.severity, "high");

  const fs = createChangeNotice(
    report({ version: "1.0.0", sha256: HASH_A, tools: [] }),
    report({ version: "1.1.0", sha256: HASH_B, tools: [], indicators: ["filesystem-api"] })
  );
  assert.equal(fs.changes.find((c) => c.kind === "indicator_added")?.severity, "review");
});

// Regression: a baseline with no inventory must not make every tool look new.
test("does not invent tool changes when the baseline has no inventory", () => {
  const notice = createChangeNotice(
    report({ version: "1.0.0", sha256: HASH_A }),
    report({ version: "1.1.0", sha256: HASH_B, tools: [{ name: "alpha" }, { name: "beta" }] })
  );
  assert.equal(notice.changes.some((c) => c.kind === "tool_added"), false);
  assert.equal(notice.changes.some((c) => c.kind === "comparison_limited"), true);
  assert.equal(notice.severity, "review");
});

// Regression: a tool the extractor failed to parse is not a removal.
test("treats a missing tool as inconclusive when extraction was incomplete", () => {
  const notice = createChangeNotice(
    report({ version: "1.0.0", sha256: HASH_A, tools: [{ name: "alpha" }, { name: "beta" }], toolsComplete: true }),
    report({ version: "1.1.0", sha256: HASH_B, tools: [{ name: "alpha" }], toolsComplete: false })
  );
  assert.equal(notice.changes.some((c) => c.kind === "tool_removed"), false);
  assert.equal(notice.changes.some((c) => c.kind === "comparison_limited"), true);
});

test("an identical rebuild produces no reviewable changes", () => {
  const options = {
    version: "1.0.0",
    sha256: HASH_A,
    dependencies: { alpha: "1.0.0" },
    tools: [{ name: "t", description_sha256: "d1", input_schema_sha256: "s1" }],
    metadata: { description: "Same" }
  };
  const notice = createChangeNotice(report(options), report(options));
  assert.deepEqual(notice.changes, []);
  assert.equal(notice.severity, "info");
  assert.match(notice.summary, /no normalized changes/);
});

test("every change carries a severity", () => {
  const notice = createChangeNotice(
    report({ version: "1.0.0", sha256: HASH_A, tools: [], metadata: { scripts: {}, bin: { a: "./a.js" } } }),
    report({
      version: "2.0.0",
      sha256: HASH_B,
      tools: [{ name: "new" }],
      indicators: ["network-api"],
      dependencies: { added: "1.0.0" },
      metadata: { scripts: { postinstall: "x" }, bin: { a: "./b.js" } }
    })
  );
  assert.ok(notice.changes.length >= 5);
  assert.equal(notice.changes.every((c) => ["info", "review", "high"].includes(c.severity)), true);
  assert.equal(notice.severity, "high");
});

test("refuses to compare different package identities", () => {
  const baseline = report({ version: "1.0.0", sha256: HASH_A });
  const candidate = report({ version: "1.1.0", sha256: HASH_B });
  candidate.subject.artifact.package = "different-mcp";
  assert.throws(() => createChangeNotice(baseline, candidate), /different npm package/);
});
