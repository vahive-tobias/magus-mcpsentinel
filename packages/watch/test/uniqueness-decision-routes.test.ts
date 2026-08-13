import assert from "node:assert/strict";
import test from "node:test";
import { noticeLinkToken } from "../src/auth.js";
import worker from "../src/worker.js";
import { memoryDatabase, notice, target, type ReportRow } from "./memory-d1.js";
import type { ChangeNoticeRecord, Env } from "../src/types.js";

/**
 * S3 of the uniqueness enumeration — one notice, two routes that may decide it.
 *
 * The operator route and the capability link both reach `decideNotice`, and they
 * do not agree about a notice that has already been decided: the link refuses to
 * overturn one, the operator route will happily flip `accepted → ignored →
 * accepted`. Where two paths to the same mutation disagree, the authority is
 * whichever path the caller happened to use, which is the violation shape.
 *
 * **This pins current behaviour; it does not endorse it.** Whether a decision is
 * absorbing is a product call, and either answer is defensible. Two answers is
 * not. See `docs/PLAN_UNIQUENESS_ENUMERATION_WATCH.md`, S3.
 */

const KEY = "operator-key-for-tests";
const SECRET = "notice-link-secret-for-tests";
const NOTICE_ID = "33333333-3333-4333-8333-333333333333";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const REPORTS: ReportRow[] = [
  { id: "r0", target_id: "t1", package_version: "1.4.0", received_at: "2026-08-01T00:00:00.000Z" },
  { id: "r1", target_id: "t1", package_version: "2.0.0", received_at: "2026-08-08T00:00:00.000Z" }
];

type State = ChangeNoticeRecord["state"];
const STATES: State[] = ["pending_review", "accepted", "frozen", "ignored"];

function world(from: State) {
  const store = memoryDatabase({
    targets: [target({ baseline_report_id: from === "accepted" ? "r1" : "r0" })],
    notices: [notice({ id: NOTICE_ID, baseline_report_id: "r0", candidate_report_id: "r1", state: from })],
    reports: [...REPORTS]
  });
  const env = { DB: store.db, OPERATOR_API_KEY: KEY, NOTICE_LINK_SECRET: SECRET } as unknown as Env;
  return { store, env };
}

async function viaOperator(from: State, decision: "accepted" | "frozen" | "ignored") {
  const { store, env } = world(from);
  const response = await worker.fetch(new Request(`https://watch.test/api/notices/${NOTICE_ID}/decision`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ state: decision })
  }), env, ctx);
  return { status: response.status, state: store.notices[0]!.state, baseline: store.targets[0]!.baseline_report_id };
}

async function viaLink(from: State) {
  const { store, env } = world(from);
  const token = await noticeLinkToken(NOTICE_ID, SECRET);
  const response = await worker.fetch(
    new Request(`https://watch.test/notice/${NOTICE_ID}/accept?t=${token}`, { method: "POST" }), env, ctx);
  return { status: response.status, state: store.notices[0]!.state, baseline: store.targets[0]!.baseline_report_id };
}

test("the two routes disagree about a notice that is already decided", async () => {
  // The finding, stated as an assertion so it cannot quietly change.
  for (const from of STATES.filter((state) => state !== "pending_review")) {
    const link = await viaLink(from);
    assert.equal(link.state, from, `the link overturned a ${from} notice`);

    const operator = await viaOperator(from, "accepted");
    assert.equal(operator.state, "accepted", `the operator route refused to redecide a ${from} notice`);

    if (from !== "accepted") {
      assert.notEqual(link.state, operator.state,
        `the routes agreed about a ${from} notice, so this test is now stating something false`);
    }
  }
});

test("accepting a pending notice does the same thing by either route", async () => {
  // Where they do agree, they must agree completely — same state, same baseline.
  const link = await viaLink("pending_review");
  const operator = await viaOperator("pending_review", "accepted");
  assert.equal(link.state, "accepted");
  assert.equal(operator.state, "accepted");
  assert.equal(link.baseline, "r1");
  assert.equal(operator.baseline, "r1");
});

test("no route moves the baseline except by accepting", async () => {
  for (const from of STATES) {
    for (const decision of ["frozen", "ignored"] as const) {
      const before = from === "accepted" ? "r1" : "r0";
      const result = await viaOperator(from, decision);
      assert.equal(result.baseline, before, `${decision} from ${from} moved the baseline`);
    }
  }
});

/**
 * The whole outcome matrix, pinned.
 *
 * Reading it is the point: every cell is a (starting state, route, decision) tuple
 * with exactly one recorded outcome, so a change to either route shows up here as
 * a diff rather than as behaviour nobody noticed.
 */
test("every route and starting state has exactly one recorded outcome", async () => {
  const observed: Record<string, string> = {};

  for (const from of STATES) {
    for (const decision of ["accepted", "frozen", "ignored"] as const) {
      const result = await viaOperator(from, decision);
      observed[`operator ${from} -> ${decision}`] = `${result.status} ${result.state} ${result.baseline}`;
    }
    const link = await viaLink(from);
    observed[`link ${from} -> accept`] = `${link.status} ${link.state} ${link.baseline}`;
  }

  assert.deepEqual(observed, {
    "operator pending_review -> accepted": "200 accepted r1",
    "operator pending_review -> frozen": "200 frozen r0",
    "operator pending_review -> ignored": "200 ignored r0",
    "link pending_review -> accept": "200 accepted r1",

    // Already accepted: the link is a no-op, and the operator route can undo it.
    "operator accepted -> accepted": "200 accepted r1",
    "operator accepted -> frozen": "200 frozen r1",
    "operator accepted -> ignored": "200 ignored r1",
    "link accepted -> accept": "200 accepted r1",

    // The asymmetry, in two rows: the operator route accepts a frozen notice and
    // moves the baseline; the link leaves it frozen and moves nothing.
    "operator frozen -> accepted": "200 accepted r1",
    "operator frozen -> frozen": "200 frozen r0",
    "operator frozen -> ignored": "200 ignored r0",
    "link frozen -> accept": "200 frozen r0",

    "operator ignored -> accepted": "200 accepted r1",
    "operator ignored -> frozen": "200 frozen r0",
    "operator ignored -> ignored": "200 ignored r0",
    "link ignored -> accept": "200 ignored r0"
  });
});
