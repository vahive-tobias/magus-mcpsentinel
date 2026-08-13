import assert from "node:assert/strict";
import test from "node:test";
import { WatchRepository } from "../src/repository.js";
import { memoryDatabase, notice, target, type ReportRow } from "./memory-d1.js";

/**
 * S2 of the uniqueness enumeration — which release ends up approved.
 *
 * This is the surface that failed. Several releases can be outstanding at once,
 * each with its own notice, every one measured against the same approved version.
 * `setBaseline` ran on any accept, so the final baseline depended on the order the
 * notices were clicked — one input, several reachable outcomes, with click order
 * holding the authority.
 *
 * Depth is five because a real backlog reached five outstanding notices for
 * `@transcend-io/mcp-server-docs`. Exhaustive to that depth, not to all depths.
 */

const RELEASES = ["0.3.11", "0.3.12", "0.3.13", "0.3.14", "0.3.15"];

/** Reports arrive in release order; arrival is what the guard reads. */
function reports(): ReportRow[] {
  return [
    { id: "r0", target_id: "t1", package_version: "0.3.10", received_at: "2026-08-09T00:00:00.000Z" },
    ...RELEASES.map((version, index) => ({
      id: `r${index + 1}`,
      target_id: "t1",
      package_version: version,
      received_at: `2026-08-1${index}T00:00:00.000Z`
    }))
  ];
}

/** One notice per outstanding release, all measured against the same baseline. */
function notices() {
  return RELEASES.map((_, index) => notice({
    id: `n${index + 1}`,
    baseline_report_id: "r0",
    candidate_report_id: `r${index + 1}`,
    detected_at: `2026-08-1${index}T00:17:00.000Z`
  }));
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

test("every order of accepting the same backlog approves the same release", async () => {
  const orders = permutations(notices().map((row) => row.id));
  assert.equal(orders.length, 120, "five outstanding notices, exhaustively ordered");

  for (const order of orders) {
    const store = memoryDatabase({ targets: [target()], notices: notices(), reports: reports() });
    const repository = new WatchRepository(store.db);
    for (const id of order) await repository.decideNotice(id, "accepted");

    assert.equal(store.targets[0]!.baseline_report_id, "r5",
      `accepting in the order ${order.join(", ")} approved something other than the newest release`);
    assert.ok(store.notices.every((row) => row.state === "accepted"),
      "every decision must still be recorded, whatever it did to the baseline");
  }
});

test("the approved release never moves backwards, at any point in any order", async () => {
  // The end state being right is not enough. A baseline that dips to an older
  // release and recovers has, in between, compared a real release against a
  // version the reader had already moved past.
  const arrival = new Map(reports().map((row) => [row.id, row.received_at]));

  for (const order of permutations(notices().map((row) => row.id))) {
    const store = memoryDatabase({ targets: [target()], notices: notices(), reports: reports() });
    const repository = new WatchRepository(store.db);
    let previous = arrival.get("r0")!;

    for (const id of order) {
      await repository.decideNotice(id, "accepted");
      const current = arrival.get(store.targets[0]!.baseline_report_id!)!;
      assert.ok(current >= previous,
        `accepting ${id} in the order ${order.join(", ")} moved the approved release backwards`);
      previous = current;
    }
  }
});

test("accepting the same notice twice changes nothing the second time", async () => {
  const store = memoryDatabase({ targets: [target()], notices: notices(), reports: reports() });
  const repository = new WatchRepository(store.db);

  await repository.decideNotice("n3", "accepted");
  const after = store.targets[0]!.baseline_report_id;
  const writes = store.executed.filter((entry) => /UPDATE watch_targets/.test(entry.sql)).length;

  await repository.decideNotice("n3", "accepted");
  assert.equal(store.targets[0]!.baseline_report_id, after);
  assert.equal(store.executed.filter((entry) => /UPDATE watch_targets/.test(entry.sql)).length, writes,
    "a repeated accept rewrote the baseline it already held");
});

test("freezing or ignoring never moves the approved release", async () => {
  for (const state of ["frozen", "ignored"] as const) {
    for (const id of notices().map((row) => row.id)) {
      const store = memoryDatabase({ targets: [target()], notices: notices(), reports: reports() });
      const repository = new WatchRepository(store.db);
      await repository.decideNotice(id, state);
      assert.equal(store.targets[0]!.baseline_report_id, "r0",
        `${state} on ${id} moved the baseline`);
    }
  }
});

test("a target with no baseline yet adopts whatever it is first given", async () => {
  // The one case where any candidate may become the baseline: there is nothing to
  // move backwards from, and a target must start somewhere.
  const store = memoryDatabase({
    targets: [target({ baseline_report_id: null })],
    notices: notices(),
    reports: reports()
  });
  const repository = new WatchRepository(store.db);
  await repository.decideNotice("n2", "accepted");
  assert.equal(store.targets[0]!.baseline_report_id, "r2");
});

test("a candidate whose report is missing does not move the baseline", async () => {
  // An arrival time that cannot be read is not evidence that this release is newer.
  const store = memoryDatabase({
    targets: [target()],
    notices: [notice({ id: "n9", baseline_report_id: "r0", candidate_report_id: "r-missing" })],
    reports: reports()
  });
  const repository = new WatchRepository(store.db);
  await repository.decideNotice("n9", "accepted");

  assert.equal(store.targets[0]!.baseline_report_id, "r0");
  assert.equal(store.notices[0]!.state, "accepted", "the decision is still recorded");
});
