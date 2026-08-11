import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";
import type { Env, StoredReportRecord } from "../src/types.js";

/**
 * The HTTP surface, and specifically where it stops being public.
 *
 * The gate in `fetch` is positional: every route declared above the
 * `verifyApiKey` line is reachable without a key and every route below it is not.
 * That is efficient and it is one misplaced line away from publishing the watch
 * list, so the boundary is asserted here rather than remembered.
 */

const KEY = "operator-key-for-tests";

const REPORT: StoredReportRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  target_id: "t1",
  artifact_sha256: "a".repeat(64),
  package_version: "3.23.8",
  report_sha256: "b".repeat(64),
  report_json: JSON.stringify({ format_version: "0.2.0" }),
  generated_at: "2026-08-10T00:00:00.000Z",
  received_at: "2026-08-10T00:00:01.000Z"
};

function env(row: unknown = REPORT): Env {
  const database = {
    prepare() {
      const statement = {
        bind() { return statement; },
        async first() { return row; },
        async run() { return { success: true }; },
        async all() { return { results: [] }; }
      };
      return statement;
    }
  };
  return { DB: database, OPERATOR_API_KEY: KEY } as unknown as Env;
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function get(path: string, key?: string): Request {
  return new Request(`https://watch.test${path}`, {
    method: "GET",
    ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {})
  });
}

test("a stored report is readable by id, unchanged", async () => {
  const response = await worker.fetch(get(`/api/reports/${REPORT.id}`, KEY), env(), ctx);
  assert.equal(response.status, 200);

  const body = await response.json() as { report: StoredReportRecord };
  // Returned as stored: a consumer that has to trust our paraphrase of the
  // evidence cannot verify it against the artifact.
  assert.equal(body.report.report_json, REPORT.report_json);
  assert.equal(body.report.package_version, "3.23.8", "the version a notice does not record");
});

test("an unknown report id is 404, not an empty success", async () => {
  const response = await worker.fetch(get(`/api/reports/${REPORT.id}`, KEY), env(null), ctx);
  assert.equal(response.status, 404);
});

test("reading a report requires the operator key", async () => {
  for (const request of [get(`/api/reports/${REPORT.id}`), get(`/api/reports/${REPORT.id}`, "wrong-key")]) {
    const response = await worker.fetch(request, env(), ctx);
    assert.equal(response.status, 401, "an unauthenticated read must not reach the database");
  }
});

// The whole gate, not just the route added with it. A public route added above
// the line is the failure this is here to catch, and it would not show up in a
// test that only exercised the route its author was thinking about.
test("every operator route is behind the key", async () => {
  for (const path of ["/api/targets", "/api/notices", `/api/reports/${REPORT.id}`]) {
    const response = await worker.fetch(get(path), env(), ctx);
    assert.equal(response.status, 401, `${path} answered without a key`);
  }
});

test("the routes that are meant to be public still are", async () => {
  // `/` is a shell that asks for the key client-side and carries no data; health
  // is a liveness check. Both are deliberately reachable.
  assert.equal((await worker.fetch(get("/"), env(), ctx)).status, 200);
  assert.equal((await worker.fetch(get("/health"), env(), ctx)).status, 200);
});

test("the ingest route is not reachable as a read", async () => {
  // POST /api/reports sits above the gate. A GET of the same path must not be
  // mistaken for the single-report read, which is authenticated.
  const response = await worker.fetch(get("/api/reports"), env(), ctx);
  assert.equal(response.status, 401, "an unmatched path below the gate must not answer");
});
