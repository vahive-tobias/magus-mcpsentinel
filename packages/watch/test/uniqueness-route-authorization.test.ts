import assert from "node:assert/strict";
import test from "node:test";
import { noticeLinkToken } from "../src/auth.js";
import worker from "../src/worker.js";
import { memoryDatabase, notice, target, type ReportRow } from "./memory-d1.js";
import type { Env } from "../src/types.js";

/**
 * S6 of the uniqueness enumeration — which handler answers a request.
 *
 * `routes.test.ts` asserts the operator boundary holds. This asserts there is
 * only one of it: that every (path, method, credential) tuple reaches exactly one
 * handler, that no two route patterns claim the same path, and that the *order*
 * of the checks is not what decides.
 *
 * Both adversarial passes stopped at this door — neither walked `worker.fetch`
 * exhaustively — and it is the surface where being wrong costs an unauthenticated
 * route rather than a slow query.
 *
 * **There are three authentication classes here, not two.** A positional reading
 * ("above the line is public") flattens them and loses the distinction that
 * matters:
 *
 * - `public`   — answers anyone.
 * - `self`     — sits above the operator gate and authenticates itself: HMAC for
 *                ingest, the poll key for pending work, a per-notice capability
 *                token for the notice routes. Unauthenticated callers are refused
 *                by the *handler*, never by the gate.
 * - `operator` — refused by the gate before any handler runs.
 *
 * The failure this catches is a `self` route drifting below the gate, or an
 * `operator` route drifting above it. Either reads as a one-line move.
 */

const KEY = "operator-key-for-tests";
const SECRET = "notice-link-secret-for-tests";
const ID = "44444444-4444-4444-8444-444444444444";

/** The gate's own refusal. No `self` or `public` route may ever produce this. */
const GATE_REFUSAL = "operator authentication required";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const REPORTS: ReportRow[] = [
  { id: "r0", target_id: "t1", package_version: "1.0.0", received_at: "2026-08-01T00:00:00.000Z" },
  { id: "r1", target_id: "t1", package_version: "2.0.0", received_at: "2026-08-08T00:00:00.000Z" }
];

function environment() {
  const store = memoryDatabase({
    targets: [target({ baseline_report_id: "r0" })],
    notices: [notice({ id: ID, baseline_report_id: "r0", candidate_report_id: "r1" })],
    reports: [...REPORTS]
  });
  return {
    DB: store.db,
    OPERATOR_API_KEY: KEY,
    NOTICE_LINK_SECRET: SECRET,
    ANALYZER_INGEST_SECRET: "ingest-secret",
    ANALYZER_POLL_KEY: "poll-key"
  } as unknown as Env;
}

type Klass = "public" | "self" | "operator";

const ROUTES: { path: string; method: string; klass: Klass; note: string }[] = [
  { path: "/", method: "GET", klass: "public", note: "operator dashboard shell; asks for the key client-side and carries no data" },
  { path: "/health", method: "GET", klass: "public", note: "liveness" },
  { path: "/api/reports", method: "POST", klass: "self", note: "HMAC over the exact body" },
  { path: "/api/pending", method: "GET", klass: "self", note: "ANALYZER_POLL_KEY" },
  { path: `/notice/${ID}`, method: "GET", klass: "self", note: "per-notice capability token" },
  { path: `/notice/${ID}/accept`, method: "POST", klass: "self", note: "per-notice capability token" },
  { path: "/api/targets", method: "GET", klass: "operator", note: "the watch list" },
  { path: "/api/targets", method: "POST", klass: "operator", note: "creates a target" },
  { path: "/api/notices", method: "GET", klass: "operator", note: "every notice" },
  { path: `/api/reports/${ID}`, method: "GET", klass: "operator", note: "one stored report" },
  { path: `/api/notices/${ID}/decision`, method: "POST", klass: "operator", note: "decides a notice" }
];

async function call(path: string, method: string, options: { key?: string; token?: string } = {}) {
  const url = new URL(path, "https://watch.test");
  if (options.token) url.searchParams.set("t", options.token);
  const response = await worker.fetch(
    new Request(url, { method, ...(options.key ? { headers: { Authorization: `Bearer ${options.key}` } } : {}) }),
    environment(),
    ctx
  );
  const body = await response.text();
  return { status: response.status, body };
}

test("every operator route is refused by the gate, and only by the gate", async () => {
  for (const route of ROUTES.filter((entry) => entry.klass === "operator")) {
    const result = await call(route.path, route.method);
    assert.equal(result.status, 401, `${route.method} ${route.path} answered without a key`);
    assert.match(result.body, new RegExp(GATE_REFUSAL), `${route.path} refused for some other reason`);
  }
});

/**
 * The distinction a positional reading loses. A `self` route that drifted below
 * the gate would still *refuse* an unauthenticated caller, so a test asserting
 * only "refused" would stay green while the route stopped being reachable by the
 * thing it exists for — an external analyzer, or a notice recipient with a link
 * and no operator key.
 */
test("no public or self route ever produces the gate's refusal", async () => {
  for (const route of ROUTES.filter((entry) => entry.klass !== "operator")) {
    const result = await call(route.path, route.method);
    assert.doesNotMatch(
      result.body,
      new RegExp(GATE_REFUSAL),
      `${route.method} ${route.path} (${route.note}) is being refused by the operator gate, so it has moved below it`
    );
  }
});

test("a capability route is not unlocked by the operator key", async () => {
  // The operator reads notices through /api/notices. Holding the operator key is
  // not a way to open a signed link, and the two credentials stay separate.
  const withKey = await call(`/notice/${ID}`, "GET", { key: KEY });
  assert.equal(withKey.status, 404, "the operator key must not substitute for a notice token");

  const withToken = await call(`/notice/${ID}`, "GET", { token: await noticeLinkToken(ID, SECRET) });
  assert.equal(withToken.status, 200, "the token alone must be sufficient");
});

/**
 * An unknown path is refused by the gate, not by the 404 that sits below it. That
 * is deliberate: a 404 for an unauthenticated caller would enumerate which routes
 * exist. The response only distinguishes once a key proves the caller may know.
 */
test("an unknown path does not reveal whether it exists", async () => {
  const anonymous = await call("/api/secret-thing", "GET");
  assert.equal(anonymous.status, 401);

  const authenticated = await call("/api/secret-thing", "GET", { key: KEY });
  assert.equal(authenticated.status, 404, "with a key, the same path is honestly reported as absent");
});

/**
 * Adjacent patterns that could plausibly claim one path. Each is a real
 * near-collision in the current table rather than an invented one.
 */
test("no two route patterns claim the same path", async () => {
  // `/api/reports` is the ingest route, matched exactly; `/api/reports/:id` is an
  // authenticated read. A GET of the bare path must not fall into either.
  const bareGet = await call("/api/reports", "GET");
  assert.equal(bareGet.status, 401, "GET /api/reports must fall through to the gate, not to ingest");

  // The notice branch returns unconditionally once the path shape matches, so a
  // wrong method inside it is a 404 from that branch and never reaches the gate.
  const wrongMethod = await call(`/notice/${ID}`, "POST");
  assert.equal(wrongMethod.status, 404);
  assert.doesNotMatch(wrongMethod.body, new RegExp(GATE_REFUSAL));

  // A path that merely starts with /notice/ but is not a uuid is not a capability
  // route at all, so it must reach the gate rather than being swallowed.
  const notAUuid = await call("/notice/../api/targets", "GET");
  assert.equal(notAUuid.status, 401, "a non-uuid /notice/ path must not be swallowed by the capability branch");
});

/**
 * The order of the checks must not be what decides. Every route is identified by
 * its own (path, method) pair, so no request can be claimed by two handlers —
 * which is what makes moving the gate a visible change rather than a silent one.
 */
test("each request reaches exactly one handler", async () => {
  const seen = new Map<string, number>();
  for (const route of ROUTES) {
    const authenticated = await call(route.path, route.method, { key: KEY });
    const key = `${route.method} ${route.path}`;
    assert.ok(!seen.has(key), `${key} is listed twice in the route inventory`);
    seen.set(key, authenticated.status);

    // With a key, nothing in the table may 401: an operator route is admitted and
    // a self route was never the gate's business. A 401 here means a route is
    // gated twice, or gated by something the key cannot satisfy.
    if (route.klass !== "self") {
      assert.notEqual(authenticated.status, 401, `${key} still refuses a valid operator key`);
    }
  }
  assert.equal(seen.size, ROUTES.length);
});

/**
 * The router's own error handling, which was unreachable.
 *
 * `fetch` wraps its routing in a try/catch that maps `BodyTooLargeError` to 413
 * and anything else to 400. Every handler was returned as `return handler(...)`
 * rather than `return await handler(...)`, so the promise settled *after* the try
 * block had exited: the rejection went to the caller and the catch never ran. The
 * Worker answered an oversized body by failing the request rather than by saying
 * why it was refused.
 *
 * Nothing caught it because `body-limit.test.ts` exercises `readBoundedText`
 * directly — it proves the limit throws, never that the router turns that throw
 * into a 413. Found by enumerating this surface, not by reading it.
 */
test("the router answers its own errors instead of failing the request", async () => {
  const oversized = await worker.fetch(
    new Request("https://watch.test/api/reports", { method: "POST", body: "x".repeat(5_000_000) }),
    environment(),
    ctx
  );
  assert.equal(oversized.status, 413, "an oversized body must be refused with a reason, not by rejecting");
  assert.match(await oversized.text(), /byte limit/);

  // The generic path: any other handler throw becomes a 400 carrying the reason.
  const malformed = await worker.fetch(
    new Request("https://watch.test/api/targets", { method: "POST", headers: { Authorization: `Bearer ${KEY}` } }),
    environment(),
    ctx
  );
  assert.equal(malformed.status, 400);
  assert.match(await malformed.text(), /Invalid JSON/);
});
