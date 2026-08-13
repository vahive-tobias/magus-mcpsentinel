import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FORMAT_VERSION, OBSERVATION_IDS, OBSERVATION_KINDS } from "magus-mcpsentinel/report-contract";
import type { ReportObservation, SentinelReport } from "magus-mcpsentinel/report-contract";
import { CLASSIFIED_COVERAGE_LOSS_REASONS, createChangeNotice } from "../src/policy.js";

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
      data: { complete: options.toolsComplete ?? true, incompleteness: options.toolsIncompleteness ?? [], tools: options.tools }
    });
  }

  return {
    format_version: FORMAT_VERSION,
    report_id: "11111111-1111-4111-8111-111111111111",
    generated_at: "2026-08-05T00:00:00.000Z",
    // One analyzer build on both sides. A cross-build comparison withholds tool
    // conclusions entirely, which is a diff concern with its own coverage there.
    analysis: { engine: { name: "sentinel", version: "0.2.0", build_sha256: "a".repeat(64) } },
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

const baselineForCoverage = report({ version: "1.0.0", sha256: HASH_A, tools: [{ name: "alpha" }], toolsComplete: true });

function coverageSeverity(reasons: string[]): string | undefined {
  return createChangeNotice(
    baselineForCoverage,
    report({ version: "1.1.0", sha256: HASH_B, tools: [{ name: "alpha" }], toolsComplete: false, toolsIncompleteness: reasons })
  ).changes.find((c) => c.kind === "coverage_regressed")?.severity;
}

// A surface that stopped being declared readably is the package moving; a shape
// our extractor cannot reach is us. Only the first ranks as capability-level.
test("coverage lost by the package is high; coverage lost to our own reach is review", () => {
  for (const reason of [
    "source_file_failed_to_parse",
    "source_file_exceeded_parse_size_limit",
    "registration_name_not_static",
    "list_tools_handler_not_static",
    "list_tools_array_not_static",
    "list_tools_array_uses_spread",
    "list_tools_entry_not_static",
    "list_tools_entry_name_not_static"
  ]) {
    assert.equal(coverageSeverity([reason]), "high", `${reason} should rank high`);
  }

  for (const reason of [
    "typescript_source_not_parsed",
    "no_recognized_registration_pattern",
    "tools_inferred_from_definitions_only"
  ]) {
    assert.equal(coverageSeverity([reason]), "review", `${reason} should rank review`);
  }
});

test("the strongest reason decides, and an unrecorded one is still not benign", () => {
  assert.equal(coverageSeverity(["no_recognized_registration_pattern", "source_file_failed_to_parse"]), "high");
  assert.equal(coverageSeverity([]), "review");
  assert.equal(coverageSeverity(["a_reason_from_a_newer_analyzer"]), "review");
});

/**
 * The classification must cover every reason the analyzer can actually emit.
 *
 * Written by hand first against the five reasons visible in the extractor's
 * top-level function, which missed seven added deeper in the same file — every one
 * of them a tool list that became computed rather than declared, which is the shape
 * this finding exists to catch. They took the fallback and ranked as `review`.
 * Reading them out of the source is what makes that a failure rather than a guess.
 */
test("every reason the extractor can emit is classified", () => {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, "package.json"))) directory = dirname(directory);
  const extractor = join(directory, "..", "sentinel", "src", "tool-surface.ts");
  assert.ok(existsSync(extractor), `expected to find the extractor at ${extractor}`);

  const source = readFileSync(extractor, "utf8");
  const emitted = [...source.matchAll(/incompleteness\.add\("([a-z_]+)"\)/g)].map((match) => match[1]!);
  assert.ok(emitted.length > 0, "expected to find reason codes in the extractor");

  const unclassified = [...new Set(emitted)].filter((reason) => !CLASSIFIED_COVERAGE_LOSS_REASONS.includes(reason));
  assert.deepEqual(unclassified, [], `unclassified coverage-loss reasons: ${unclassified.join(", ")}`);
});

test("refuses to compare different package identities", () => {
  const baseline = report({ version: "1.0.0", sha256: HASH_A });
  const candidate = report({ version: "1.1.0", sha256: HASH_B });
  candidate.subject.artifact.package = "different-mcp";
  assert.throws(() => createChangeNotice(baseline, candidate), /different npm package/);
});
