import assert from "node:assert/strict";
import test from "node:test";
import { FORMAT_VERSION, OBSERVATION_IDS, OBSERVATION_KINDS } from "magus-mcpsentinel/report-contract";
import type { ReportObservation, SentinelReport } from "magus-mcpsentinel/report-contract";
import { createChangeNotice } from "../src/policy.js";
import type { Severity } from "../src/types.js";

/**
 * How much a change to a package's declared surface matters.
 *
 * The analyzer says a `SKILL.md` was rewritten; this decides whether that is
 * worth interrupting someone for. A skill is instructions a model reads and
 * acts on, so a new one hands the agent a capability it did not have — the same
 * reasoning that ranks a new tool `high`. A rewritten one is a change to read.
 * A removed one is a capability lost, which is context rather than an alarm.
 */

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const SKILL = "package/skills/summarise/SKILL.md";

function report(version: string, artifactSha: string, files: Array<{ path: string; sha256: string }>): SentinelReport {
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
      data: { entries: files.map((file) => ({ path: file.path, type: "file", sha256: file.sha256 })) }
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

function severityOf(baseline: SentinelReport, candidate: SentinelReport, kind: string): Severity | undefined {
  return createChangeNotice(baseline, candidate).changes.find((change) => change.kind === kind)?.severity;
}

const OTHER = { path: "package/index.js", sha256: HASH_A };

/**
 * Any change to a skill ranks high, whichever direction it went.
 *
 * Ranking these by direction asked the wrong question. A skill is a document the
 * model reads as instruction, so what matters to the reader is that the thing
 * steering their agent is no longer the thing they approved — and a skill that
 * vanished says that as plainly as one that appeared. `high` is a recommendation
 * to read the diff, not a claim about the package; the notice says so in words.
 */
test("a new skill is high: the agent gained instructions it did not have", () => {
  const baseline = report("1.0.0", HASH_A, [OTHER]);
  const candidate = report("1.1.0", HASH_B, [OTHER, { path: SKILL, sha256: HASH_B }]);
  assert.equal(severityOf(baseline, candidate, "skill_changed"), "high");
});

test("a rewritten skill is high: the instructions are not the ones approved", () => {
  const baseline = report("1.0.0", HASH_A, [{ path: SKILL, sha256: HASH_A }]);
  const candidate = report("1.1.0", HASH_B, [{ path: SKILL, sha256: HASH_B }]);
  assert.equal(severityOf(baseline, candidate, "skill_changed"), "high");
});

test("a removed skill is high: what the agent reads has changed either way", () => {
  const baseline = report("1.0.0", HASH_A, [{ path: SKILL, sha256: HASH_A }]);
  const candidate = report("1.1.0", HASH_B, [OTHER]);
  assert.equal(severityOf(baseline, candidate, "skill_changed"), "high");
});

test("mcp.json ranks the same way, because it declares what runs", () => {
  const mcp = (sha: string) => ({ path: "package/mcp.json", sha256: sha });

  for (const [baseline, candidate] of [
    [report("1.0.0", HASH_A, [OTHER]), report("1.1.0", HASH_B, [OTHER, mcp(HASH_B)])],
    [report("1.0.0", HASH_A, [mcp(HASH_A)]), report("1.1.0", HASH_B, [mcp(HASH_B)])],
    [report("1.0.0", HASH_A, [mcp(HASH_A)]), report("1.1.0", HASH_B, [OTHER])]
  ] as const) {
    assert.equal(severityOf(baseline, candidate, "mcp_declaration_changed"), "high");
  }
});

test("the plugin manifest is review: it is metadata, not capability", () => {
  const baseline = report("1.0.0", HASH_A, [{ path: "package/plugin.json", sha256: HASH_A }]);
  const candidate = report("1.1.0", HASH_B, [{ path: "package/plugin.json", sha256: HASH_B }]);
  assert.equal(severityOf(baseline, candidate, "plugin_manifest_changed"), "review");
});

// Every release edits files. If this were ranked any higher, every notice would
// carry a banner and the reader would learn to ignore all of them.
test("ordinary file edits stay informational and do not raise the notice", () => {
  const baseline = report("1.0.0", HASH_A, [{ path: "package/index.js", sha256: HASH_A }]);
  const candidate = report("1.1.0", HASH_B, [{ path: "package/index.js", sha256: HASH_B }]);

  const notice = createChangeNotice(baseline, candidate);
  assert.equal(notice.changes.find((change) => change.kind === "file_content_changed")?.severity, "info");
  assert.notEqual(notice.severity, "high", "an ordinary edit must not make the whole notice urgent");
});

test("a notice takes the severity of its most urgent change", () => {
  const baseline = report("1.0.0", HASH_A, [OTHER]);
  const candidate = report("1.1.0", HASH_B, [
    { path: "package/index.js", sha256: HASH_B },
    { path: SKILL, sha256: HASH_B }
  ]);

  const notice = createChangeNotice(baseline, candidate);
  assert.equal(notice.severity, "high", "a new skill alongside routine edits is still high");
});
