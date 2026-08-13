import assert from "node:assert/strict";
import test from "node:test";
import { diffReports } from "../src/diff.js";
import { FORMAT_VERSION, OBSERVATION_IDS, OBSERVATION_KINDS, type ReportObservation, type SentinelReport } from "../src/report-contract.js";

/**
 * S4 of the uniqueness enumeration — whether tool surfaces get compared at all.
 *
 * Three inputs decide it: whether each side carries an inventory, whether each
 * inventory is complete, and whether both reports came from the same analyzer
 * build. Thirty-two combinations, enumerated rather than sampled, because this
 * gate is currently refusing on every notice in production and its behaviour is
 * therefore load-bearing right now.
 *
 * The property that matters is monotone refusal: degrading any single input may
 * only move toward withholding the comparison, never toward making one. A gate
 * that could be *opened* by losing information would be the inverse of what it is
 * for.
 */

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

interface Options {
  version: string;
  sha256: string;
  tools?: string[];
  complete?: boolean;
  analyzerBuild?: string;
}

function report(options: Options): SentinelReport {
  const observations: ReportObservation[] = [{
    id: OBSERVATION_IDS.runtimeDependencies,
    kind: OBSERVATION_KINDS.dependency,
    coverage: "declared",
    data: { dependencies: {} }
  }];

  if (options.tools) {
    observations.push({
      id: OBSERVATION_IDS.staticToolInventory,
      kind: OBSERVATION_KINDS.protocolInventory,
      coverage: "inferred",
      data: {
        complete: options.complete ?? true,
        incompleteness: (options.complete ?? true) ? [] : ["registration_name_not_static"],
        tools: options.tools.map((name) => ({ name }))
      }
    });
  }

  return {
    format_version: FORMAT_VERSION,
    report_id: "11111111-1111-4111-8111-111111111111",
    generated_at: "2026-08-04T00:00:00.000Z",
    analysis: { engine: { name: "sentinel", version: "0.2.0", build_sha256: options.analyzerBuild ?? HASH_A } },
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

interface Inputs {
  baselineHasInventory: boolean;
  candidateHasInventory: boolean;
  baselineComplete: boolean;
  candidateComplete: boolean;
  sameBuild: boolean;
}

/**
 * Refusal and caveat are separate things, which is the first thing enumerating
 * this taught me.
 *
 * `missing_inventory` and `analyzer_build_differs` short-circuit: no comparison
 * happens and nothing else is reported. `incomplete_extraction` rides along with a
 * comparison that *did* happen, saying the candidate's inventory is a lower bound.
 * Collapsing the two would make a caveat look like a refusal and hide that the
 * tool surface was, in fact, compared.
 */
interface Outcome {
  compared: boolean;
  reasons: string[];
}

/** The candidate always adds a tool, so a real comparison is observable. */
function outcomeFor(inputs: Inputs, tools: { baseline: string[]; candidate: string[] } = { baseline: ["read_file"], candidate: ["read_file", "write_file"] }): Outcome {
  const diff = diffReports(
    report({
      version: "1.0.0",
      sha256: HASH_A,
      ...(inputs.baselineHasInventory ? { tools: tools.baseline } : {}),
      complete: inputs.baselineComplete
    }),
    report({
      version: "1.1.0",
      sha256: HASH_B,
      ...(inputs.candidateHasInventory ? { tools: tools.candidate } : {}),
      complete: inputs.candidateComplete,
      analyzerBuild: inputs.sameBuild ? HASH_A : HASH_B
    })
  );

  const reasons = [...new Set(diff.changes
    .filter((change) => change.kind === "comparison_limited")
    .map((change) => String((change.detail ?? {}).reason)))].sort();

  const compared = diff.changes.some((change) =>
    change.kind === "tool_added" || change.kind === "tool_removed" || change.kind === "tool_schema_changed");

  return { compared, reasons };
}

function every(): Inputs[] {
  const combinations: Inputs[] = [];
  for (let mask = 0; mask < 32; mask += 1) {
    combinations.push({
      baselineHasInventory: (mask & 1) !== 0,
      candidateHasInventory: (mask & 2) !== 0,
      baselineComplete: (mask & 4) !== 0,
      candidateComplete: (mask & 8) !== 0,
      sameBuild: (mask & 16) !== 0
    });
  }
  return combinations;
}

test("the gate admits exactly one outcome per input, and it is the stated rule", () => {
  for (const inputs of every()) {
    const expected: Outcome = !inputs.baselineHasInventory || !inputs.candidateHasInventory
      ? { compared: false, reasons: ["missing_inventory"] }
      : !inputs.sameBuild && (!inputs.baselineComplete || !inputs.candidateComplete)
        ? { compared: false, reasons: ["analyzer_build_differs"] }
        // Compared, with the candidate's lower bound noted where it is one.
        : { compared: true, reasons: inputs.candidateComplete ? [] : ["incomplete_extraction"] };

    assert.deepEqual(outcomeFor(inputs), expected, `for ${JSON.stringify(inputs)}`);
  }
});

test("losing information can only withhold a comparison, never permit one", () => {
  // Each input degraded one at a time, from every starting point. A gate that
  // opened on worse evidence would be exactly backwards.
  for (const inputs of every()) {
    if (!outcomeFor(inputs).compared) continue;
    for (const worse of [
      { ...inputs, baselineHasInventory: false },
      { ...inputs, candidateHasInventory: false },
      { ...inputs, baselineComplete: false },
      { ...inputs, candidateComplete: false },
      { ...inputs, sameBuild: false }
    ]) {
      const after = outcomeFor(worse);
      assert.ok(!after.compared || after.reasons.length >= outcomeFor(inputs).reasons.length,
        `degrading ${JSON.stringify(inputs)} to ${JSON.stringify(worse)} lost a caveat or gained a conclusion`);
    }
  }
});

test("a refusal is never accompanied by a comparison", () => {
  // The short-circuit is the whole point: a withheld conclusion must not sit in
  // the same notice as the conclusion it withheld.
  for (const inputs of every()) {
    const outcome = outcomeFor(inputs);
    if (outcome.reasons.includes("missing_inventory") || outcome.reasons.includes("analyzer_build_differs")) {
      assert.equal(outcome.compared, false, `${JSON.stringify(inputs)} both refused and compared`);
      assert.equal(outcome.reasons.length, 1, "a refusal reported more than one reason");
    }
  }
});

test("a missing inventory outranks a build difference", () => {
  // Both conditions can hold at once, so one of them has to be reported. The
  // narrower fact is the more useful one: no inventory is not a build problem,
  // and telling someone to align analyzer builds would send them nowhere.
  assert.deepEqual(outcomeFor({
    baselineHasInventory: false,
    candidateHasInventory: true,
    baselineComplete: false,
    candidateComplete: false,
    sameBuild: false
  }), { compared: false, reasons: ["missing_inventory"] });
});

test("two complete inventories are compared across analyzer builds", () => {
  // The deliberate exception: both sides are authoritative, so a difference
  // between them is a fact about the package rather than about the extractor.
  assert.deepEqual(outcomeFor({
    baselineHasInventory: true,
    candidateHasInventory: true,
    baselineComplete: true,
    candidateComplete: true,
    sameBuild: false
  }), { compared: true, reasons: [] });
});

test("an absent tool is a removal only when both inventories are complete", () => {
  // The per-tool form of the caveat, which the additive fixture above never
  // reaches. An extractor that missed a tool would otherwise report it as deleted.
  const dropped = { baseline: ["read_file", "write_file"], candidate: ["read_file"] };
  const both = { baselineHasInventory: true, candidateHasInventory: true, sameBuild: true };

  assert.deepEqual(
    outcomeFor({ ...both, baselineComplete: true, candidateComplete: true }, dropped),
    { compared: true, reasons: [] },
    "two complete inventories should report the removal outright");

  const uncertain = outcomeFor({ ...both, baselineComplete: true, candidateComplete: false }, dropped);
  assert.equal(uncertain.compared, false, "an unreliable removal must not be reported as one");
  assert.deepEqual(uncertain.reasons, ["incomplete_extraction"]);
});
