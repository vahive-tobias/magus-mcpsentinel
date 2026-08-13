import assert from "node:assert/strict";
import test from "node:test";
import { CLASSIFIED_COVERAGE_LOSS_REASONS, SEVERITY, highestSeverity, severityFor } from "../src/policy.js";
import type { ChangeKind, JsonObject, Severity, WatchChange } from "../src/types.js";

/**
 * S1 of the uniqueness enumeration — the ranking surface.
 *
 * > A deterministic layer must admit at most one outcome per input. If two are
 * > reachable, whatever picks between them holds the authority.
 *
 * Ranking is declared twice here: once as a table keyed by change kind, once as a
 * chain of branches in `severityFor`. Where both speak for the same kind, branch
 * order decides and the table is decoration. That is not a bug — behaviour is
 * whatever the branch says — but it is authority sitting somewhere nobody
 * declared, and a table entry that cannot change an outcome will eventually be
 * edited by someone who believes it can.
 */

const RANK: Record<Severity, number> = { info: 0, review: 1, high: 2 };

/**
 * Every detail shape any branch inspects, plus the shapes that make a branch
 * condition fail.
 *
 * Reachability is only ever "over this input space". A branch reading a field
 * absent from here would be invisible, so a new branch means a new entry.
 */
const DETAILS: JsonObject[] = [
  {},
  { addedProperties: [] },
  { addedProperties: ["encoding"] },
  { addedProperties: "not-an-array" },
  { indicator: "network-api" },
  { indicator: "process-spawn-api" },
  { indicator: "filesystem-api" },
  // Not a string, so `indicator_added`'s branch condition fails and execution
  // falls through. This is the one input that keeps that table entry alive.
  { indicator: 42 },
  { severity: "critical" },
  { severity: "high" },
  { severity: "low" },
  { reasons: [] },
  { reasons: [CLASSIFIED_COVERAGE_LOSS_REASONS[0]] },
  { reasons: ["a_reason_no_analyzer_has_emitted_yet"] },
  { reasons: "not-an-array" },
  { state: "added" },
  { state: "removed" },
  { state: "changed" },
  { tool: "read_file", count: 3 }
];

const KINDS = Object.keys(SEVERITY) as ChangeKind[];

function rank(kind: ChangeKind, detail: JsonObject): Severity {
  return severityFor({ kind, summary: "", detail });
}

/**
 * Whether the table entry for a kind can decide anything.
 *
 * Value equality would answer the wrong question: `coverage_regressed`'s branch
 * returns `review`, which is also its table value, so comparing outputs would call
 * a dead entry live. Replacing the entry and watching for the replacement is what
 * actually tests the path.
 */
function tableEntryIsReachable(kind: ChangeKind): boolean {
  const original = SEVERITY[kind];
  const sentinel = "sentinel-only-value" as unknown as Severity;
  SEVERITY[kind] = sentinel;
  try {
    return DETAILS.some((detail) => rank(kind, detail) === sentinel);
  } finally {
    SEVERITY[kind] = original;
  }
}

/**
 * The five kinds whose table entry cannot affect any outcome.
 *
 * Pinned rather than computed, so adding a sixth is a failure that has to be
 * looked at rather than a number that quietly moves. Two of these are worse than
 * dead: `skill_changed` and `mcp_declaration_changed` declare `high` in a table
 * whose live branch returns `review` by default, so the table states a policy the
 * code does not implement.
 */
const SHADOWED: ChangeKind[] = [
  "coverage_regressed",
  "finding_added",
  "mcp_declaration_changed",
  "skill_changed",
  "tool_schema_changed"
];

test("every change kind is ranked in exactly one place", () => {
  const shadowed = KINDS.filter((kind) => !tableEntryIsReachable(kind)).sort();
  assert.deepEqual(shadowed, SHADOWED,
    "a table entry gained or lost the ability to decide; branch order is the authority here, so this must be a deliberate change");
});

test("the table states the default a kind actually gets", () => {
  // A shadowed entry is survivable; one that also misstates the answer is not.
  // The table is what a reader consults to learn how a kind is ranked, so where it
  // disagrees with the rank an ordinary change receives — detail carrying nothing
  // the branch looks for — it is documentation that is simply false.
  const misstated = KINDS.filter((kind) => SEVERITY[kind] !== rank(kind, {})).sort();
  assert.deepEqual(misstated, ["mcp_declaration_changed", "skill_changed"],
    "the table's stated severity for a kind is not the one an ordinary change of that kind receives");

  // Naming the actual defaults, so the discrepancy is legible without running it.
  assert.equal(SEVERITY.skill_changed, "high");
  assert.equal(rank("skill_changed", {}), "review");
});

test("no input reaches two severities", () => {
  // The trivial half of uniqueness, asserted because it is cheap and because a
  // future branch that reads mutable state would break it silently.
  for (const kind of KINDS) {
    for (const detail of DETAILS) {
      const first = rank(kind, detail);
      assert.equal(rank(kind, detail), first, `${kind} with ${JSON.stringify(detail)} is not deterministic`);
      assert.ok(first in RANK, `${kind} produced ${first}, which is not a severity`);
    }
  }
});

/**
 * Evidence monotonicity — detail may raise a rank, never lower it.
 *
 * One deliberate exception, and it is a real one rather than an oversight: a
 * declared-surface file that *vanished* is a capability the agent lost, which
 * ranks below the default rather than above it.
 */
const LOWERING_ALLOWED = new Set(["skill_changed", "mcp_declaration_changed"]);

test("adding detail never lowers a severity, except where a capability was removed", () => {
  for (const kind of KINDS) {
    const base = rank(kind, {});
    for (const detail of DETAILS) {
      const withDetail = rank(kind, detail);
      if (RANK[withDetail] >= RANK[base]) continue;
      assert.ok(
        LOWERING_ALLOWED.has(kind) && detail.state === "removed",
        `${kind} dropped from ${base} to ${withDetail} on ${JSON.stringify(detail)}`
      );
    }
  }
});

test("an unclassified coverage reason ranks as something to read, not as noise", () => {
  // A report from a newer analyzer than this monitor still lost coverage.
  assert.equal(rank("coverage_regressed", { reasons: ["a_reason_no_analyzer_has_emitted_yet"] }), "review");
  assert.equal(rank("coverage_regressed", { reasons: [] }), "review");
});

/**
 * The notice's own severity is the strongest of its changes, and adding a change
 * can only raise it. Exhaustive over every subset of a mixed set.
 */
test("a notice's severity never falls when a change is added", () => {
  const sample: WatchChange[] = (["info", "review", "high", "info", "review", "high"] as Severity[])
    .map((severity, index) => ({ kind: "artifact_changed" as ChangeKind, severity, summary: `change ${index}` }));

  for (let mask = 0; mask < 1 << sample.length; mask += 1) {
    const subset = sample.filter((_, index) => (mask & (1 << index)) !== 0);
    const before = highestSeverity(subset);
    for (const [index, change] of sample.entries()) {
      if ((mask & (1 << index)) !== 0) continue;
      const after = highestSeverity([...subset, change]);
      assert.ok(RANK[after] >= RANK[before],
        `adding a ${change.severity} change lowered the notice from ${before} to ${after}`);
    }
  }
  assert.equal(highestSeverity([]), "info", "an empty notice is context, not a review");
});
