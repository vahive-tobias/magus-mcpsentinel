import assert from "node:assert/strict";
import test from "node:test";
import { diffReports, type ChangeKind } from "../src/diff.js";
import { FORMAT_VERSION, OBSERVATION_IDS, OBSERVATION_KINDS, type ReportObservation, type SentinelReport } from "../src/report-contract.js";

/**
 * Changes to files whose path is itself a declaration.
 *
 * The comparison used to hold only the set of paths, so a file rewritten in
 * place was invisible: the inventory matched, and the only evidence was the
 * whole-artifact digest moving. That is the weakest possible statement — "this
 * release differs from the one you approved, somewhere".
 *
 * It matters most for the Agent Plugins layout, where a package's declared
 * surface lives at fixed paths: `plugin.json`, `mcp.json`, and each
 * `skills/<name>/SKILL.md`. A skill is text a model reads as instructions, so
 * editing one changes what an agent does with no change to executable code at
 * all — the rug-pull this repository exists to surface, in its purest form.
 */

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** A file entry, optionally carrying the digest of its contents. */
type FileFixture = string | { path: string; sha256?: string; type?: string };

function report(version: string, artifactSha: string, files: FileFixture[]): SentinelReport {
  const entries = files.map((file) => (
    typeof file === "string"
      ? { path: file, type: "file", sha256: `${file}-digest`.padEnd(64, "0").slice(0, 64) }
      : { path: file.path, type: file.type ?? "file", ...(file.sha256 ? { sha256: file.sha256 } : {}) }
  ));

  const observations: ReportObservation[] = [
    {
      id: OBSERVATION_IDS.runtimeDependencies,
      kind: OBSERVATION_KINDS.dependency,
      coverage: "declared",
      data: { dependencies: {} }
    },
    {
      id: OBSERVATION_IDS.fileInventory,
      kind: OBSERVATION_KINDS.file,
      coverage: "declared",
      data: { entries }
    }
  ];

  return {
    format_version: FORMAT_VERSION,
    report_id: "11111111-1111-4111-8111-111111111111",
    generated_at: "2026-08-09T00:00:00.000Z",
    subject: {
      server_name: "example-mcp",
      artifact: {
        ecosystem: "npm",
        package: "example-mcp",
        version,
        sha256: artifactSha,
        acquired_at: "2026-08-09T00:00:00.000Z"
      }
    },
    analysis: {} as SentinelReport["analysis"],
    observations,
    findings: [],
    limitations: []
  } as SentinelReport;
}

function kinds(baseline: SentinelReport, candidate: SentinelReport): ChangeKind[] {
  return diffReports(baseline, candidate).changes.map((change) => change.kind);
}

function changeOf(baseline: SentinelReport, candidate: SentinelReport, kind: ChangeKind) {
  return diffReports(baseline, candidate).changes.find((change) => change.kind === kind);
}

const SKILL = "package/skills/summarise/SKILL.md";

// The gap this file exists for. Before the comparison carried digests, this
// produced only `artifact_changed`.
test("a file rewritten in place is reported, not just the artifact digest", () => {
  const baseline = report("1.0.0", HASH_A, [{ path: "package/index.js", sha256: HASH_A }]);
  const candidate = report("1.1.0", HASH_B, [{ path: "package/index.js", sha256: HASH_B }]);

  const found = kinds(baseline, candidate);
  assert.ok(found.includes("file_content_changed"), `expected a content change, got ${found.join(", ")}`);

  const change = changeOf(baseline, candidate, "file_content_changed");
  assert.equal(change?.detail?.count, 1);
  assert.deepEqual(change?.detail?.paths, ["package/index.js"]);
  assert.equal(change?.detail?.truncated, false);
});

test("an identical inventory produces no content change", () => {
  const files = [{ path: "package/index.js", sha256: HASH_A }];
  const found = kinds(report("1.0.0", HASH_A, files), report("1.0.0", HASH_A, files));

  assert.equal(found.includes("file_content_changed"), false);
  assert.equal(found.includes("file_inventory_changed"), false);
  // These fixtures carry no tool inventory, so the diff says so rather than
  // implying it compared one. Anything else here would be a regression.
  assert.deepEqual(found, ["comparison_limited"]);
});

// A directory or link has no contents, so it has no digest and cannot have been
// rewritten. Comparing it would invent a change on every release.
test("entries without a digest are compared by presence only", () => {
  const baseline = report("1.0.0", HASH_A, [{ path: "package/lib", type: "directory" }]);
  const candidate = report("1.1.0", HASH_B, [{ path: "package/lib", type: "directory" }]);
  assert.equal(kinds(baseline, candidate).includes("file_content_changed"), false);
});

test("a rewritten SKILL.md is named, with both digests as evidence", () => {
  const baseline = report("1.0.0", HASH_A, [{ path: SKILL, sha256: HASH_A }]);
  const candidate = report("1.1.0", HASH_B, [{ path: SKILL, sha256: HASH_B }]);

  const change = changeOf(baseline, candidate, "skill_changed");
  assert.ok(change, "a SKILL.md rewrite must be its own change, not buried in a file count");
  assert.equal(change?.detail?.state, "modified");
  assert.equal(change?.detail?.path, SKILL);
  assert.equal(change?.detail?.baselineSha256, HASH_A);
  assert.equal(change?.detail?.candidateSha256, HASH_B);
  // The generic summary still appears; the named change is in addition to it.
  assert.ok(kinds(baseline, candidate).includes("file_content_changed"));
});

test("an added skill is distinguished from a rewritten one", () => {
  const baseline = report("1.0.0", HASH_A, [{ path: "package/index.js", sha256: HASH_A }]);
  const candidate = report("1.1.0", HASH_B, [
    { path: "package/index.js", sha256: HASH_A },
    { path: SKILL, sha256: HASH_B }
  ]);

  const change = changeOf(baseline, candidate, "skill_changed");
  assert.equal(change?.detail?.state, "added", "a new skill is new instructions, not an edit");
});

test("a removed skill is reported as removed", () => {
  const baseline = report("1.0.0", HASH_A, [{ path: SKILL, sha256: HASH_A }]);
  const candidate = report("1.1.0", HASH_B, [{ path: "package/index.js", sha256: HASH_A }]);
  assert.equal(changeOf(baseline, candidate, "skill_changed")?.detail?.state, "removed");
});

test("plugin.json and mcp.json are recognised at the package root", () => {
  const baseline = report("1.0.0", HASH_A, [
    { path: "package/plugin.json", sha256: HASH_A },
    { path: "package/mcp.json", sha256: HASH_A }
  ]);
  const candidate = report("1.1.0", HASH_B, [
    { path: "package/plugin.json", sha256: HASH_B },
    { path: "package/mcp.json", sha256: HASH_B }
  ]);

  const found = kinds(baseline, candidate);
  assert.ok(found.includes("plugin_manifest_changed"));
  assert.ok(found.includes("mcp_declaration_changed"));
});

// Path matching has to be exact, or ordinary files start reading as declarations.
test("only the exact declared-surface paths match", () => {
  const near = [
    "package/skills/summarise/NOTES.md",      // not SKILL.md
    "package/skills/SKILL.md",                 // no skill directory
    "package/skills/a/b/SKILL.md",             // nested too deep
    "package/src/plugin.json",                 // not at the root
    "package/mcp.json.bak"                     // not the declaration
  ];
  const baseline = report("1.0.0", HASH_A, near.map((path) => ({ path, sha256: HASH_A })));
  const candidate = report("1.1.0", HASH_B, near.map((path) => ({ path, sha256: HASH_B })));

  const found = kinds(baseline, candidate);
  for (const kind of ["skill_changed", "plugin_manifest_changed", "mcp_declaration_changed"]) {
    assert.equal(found.includes(kind as ChangeKind), false, `${kind} should not match any of these paths`);
  }
  assert.ok(found.includes("file_content_changed"), "they are still ordinary content changes");
});

// A release that touches a hundred files must stay readable.
test("a large content change names a bounded sample rather than every path", () => {
  const paths = Array.from({ length: 40 }, (_, index) => `package/file-${String(index).padStart(3, "0")}.js`);
  const baseline = report("1.0.0", HASH_A, paths.map((path) => ({ path, sha256: HASH_A })));
  const candidate = report("1.1.0", HASH_B, paths.map((path) => ({ path, sha256: HASH_B })));

  const change = changeOf(baseline, candidate, "file_content_changed");
  assert.equal(change?.detail?.count, 40);
  assert.equal((change?.detail?.paths as string[]).length, 10);
  assert.equal(change?.detail?.truncated, true);
});

// The analyzer states what changed. Ranking it is the consumer's job, and this
// is the file most likely to tempt someone into breaking that.
test("no declared-surface change carries a severity", () => {
  const baseline = report("1.0.0", HASH_A, [{ path: SKILL, sha256: HASH_A }]);
  const candidate = report("1.1.0", HASH_B, [{ path: SKILL, sha256: HASH_B }]);

  for (const change of diffReports(baseline, candidate).changes) {
    assert.equal("severity" in change, false, `${change.kind} must not rank itself`);
    assert.doesNotMatch(JSON.stringify(change.detail ?? {}), /"(high|review|critical)"/);
  }
});
