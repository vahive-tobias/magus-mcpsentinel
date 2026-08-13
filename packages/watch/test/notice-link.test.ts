import assert from "node:assert/strict";
import test from "node:test";
import { noticeLinkToken } from "../src/auth.js";
import worker from "../src/worker.js";
import type { ChangeNoticeRecord, Env } from "../src/types.js";

/**
 * The capability link — the only route a customer reaches without an operator key.
 *
 * Its whole security model is one derived token scoped to one notice, so what
 * these protect is that the token is actually checked, that a failed check leaks
 * nothing about whether the notice exists, and that reading a notice is not a way
 * to change one. Mail clients and security scanners fetch links in email before a
 * human ever sees them; an accept behind a GET would be triggered by delivery.
 */

const SECRET = "notice-link-secret-for-tests";
const NOTICE_ID = "22222222-2222-4222-8222-222222222222";

const NOTICE: ChangeNoticeRecord = {
  id: NOTICE_ID,
  target_id: "t1",
  baseline_report_id: "b1",
  candidate_report_id: "c1",
  severity: "high",
  summary: "@scope/example-mcp@2.0.0 has 1 reviewable change from 1.4.0.",
  changes_json: JSON.stringify([
    {
      kind: "file_inventory_changed",
      severity: "info",
      summary: "File inventory changed: 1 added, 0 removed.",
      detail: { added: ["package/dist/www-authenticate.js"] }
    }
  ]),
  state: "pending_review",
  detected_at: "2026-08-08T00:00:00.000Z",
  decided_at: null,
  delivery_state: "sent",
  delivery_attempts: 1,
  delivered_at: "2026-08-08T00:00:01.000Z",
  delivery_detail: null
};

interface Recorded { sql: string; parameters: unknown[] }

/**
 * A D1 stub that answers by table, and records every statement.
 *
 * Recording is the point: "a GET does not mutate" is only checkable by looking at
 * what was executed, not at what came back.
 */
/**
 * Report rows, keyed by id, in the order they arrived.
 *
 * `received_at` is what decides whether an accept moves the baseline forward, so
 * the stub has to carry it — a fixture that returns only a version string cannot
 * express "this release arrived before the one already approved".
 */
const REPORTS: Record<string, { package_version: string; received_at: string }> = {
  b1: { package_version: "1.4.0", received_at: "2026-08-01T00:00:00.000Z" },
  c1: { package_version: "2.0.0", received_at: "2026-08-08T00:00:00.000Z" },
  c2: { package_version: "2.1.0", received_at: "2026-08-09T00:00:00.000Z" }
};

function env(overrides: {
  notice?: ChangeNoticeRecord | null;
  secret?: string | undefined;
  /** What the target currently has approved. Defaults to the notice's baseline. */
  baselineReportId?: string;
} = {}): { env: Env; executed: Recorded[] } {
  const executed: Recorded[] = [];
  const notice = overrides.notice === undefined ? NOTICE : overrides.notice;
  // Mutable, because the page is rendered from a read that happens *after* the
  // accept. A stub that answered from a frozen row would report the old baseline
  // as the new one and the assertion would be meaningless.
  let baselineReportId = overrides.baselineReportId ?? "b1";

  const database = {
    prepare(sql: string) {
      let parameters: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { parameters = values; return statement; },
        async first() {
          executed.push({ sql, parameters });
          if (/FROM change_notices/.test(sql)) return notice;
          if (/FROM watch_targets/.test(sql)) {
            return { id: "t1", package_name: "@scope/example-mcp", baseline_report_id: baselineReportId };
          }
          if (/FROM analysis_reports/.test(sql)) {
            return REPORTS[String(parameters[0])] ?? null;
          }
          return null;
        },
        async run() {
          executed.push({ sql, parameters });
          if (/UPDATE watch_targets SET baseline_report_id/.test(sql)) baselineReportId = String(parameters[0]);
          return { success: true };
        },
        async all() { executed.push({ sql, parameters }); return { results: [] }; }
      };
      return statement;
    }
  };

  return {
    executed,
    env: {
      DB: database,
      OPERATOR_API_KEY: "operator-key-for-tests",
      ...("secret" in overrides ? { NOTICE_LINK_SECRET: overrides.secret } : { NOTICE_LINK_SECRET: SECRET })
    } as unknown as Env
  };
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function token(): Promise<string> {
  return noticeLinkToken(NOTICE_ID, SECRET);
}

function request(path: string, method = "GET"): Request {
  return new Request(`https://watch.test${path}`, { method });
}

function writes(executed: Recorded[]): Recorded[] {
  return executed.filter((entry) => /^\s*(UPDATE|INSERT|DELETE)/i.test(entry.sql));
}

test("a valid token renders the notice, with its evidence", async () => {
  const { env: environment } = env();
  const response = await worker.fetch(request(`/notice/${NOTICE_ID}?t=${await token()}`), environment, ctx);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);

  const body = await response.text();
  assert.match(body, /@scope\/example-mcp/);
  assert.match(body, /1\.4\.0/, "the approved version it compared against");
  assert.match(body, /2\.0\.0/);
  assert.match(body, /www-authenticate\.js/, "the named file, same as the email");
  assert.match(body, /Accept this version as the new baseline/);
  assert.doesNotMatch(body, /\b(malicious|unsafe|dangerous|compromised)\b/i, "a notice page states evidence, never a verdict");
});

test("a wrong or missing token is 404, and says nothing about the notice", async () => {
  for (const path of [
    `/notice/${NOTICE_ID}`,
    `/notice/${NOTICE_ID}?t=`,
    `/notice/${NOTICE_ID}?t=${"f".repeat(64)}`,
    `/notice/${NOTICE_ID}?t=not-hex`
  ]) {
    const { env: environment, executed } = env();
    const response = await worker.fetch(request(path), environment, ctx);
    assert.equal(response.status, 404, `${path} answered`);

    const body = await response.text();
    // Confirming that a notice exists but the token is wrong confirms the
    // identifier, and the identifier is the only thing protecting the record.
    assert.doesNotMatch(body, /example-mcp/, `${path} leaked the package`);
    assert.equal(executed.length, 0, `${path} reached the database before checking the token`);
  }
});

test("reading a notice does not decide it", async () => {
  // Mail clients and link scanners fetch what arrives in an inbox. A GET that
  // accepted would be triggered by the act of delivering the email.
  const { env: environment, executed } = env();
  await worker.fetch(request(`/notice/${NOTICE_ID}?t=${await token()}`), environment, ctx);
  assert.deepEqual(writes(executed), [], "a read wrote to the database");
});

test("accepting rebaselines the target, and is a POST", async () => {
  const value = await token();
  const { env: environment, executed } = env();
  const response = await worker.fetch(request(`/notice/${NOTICE_ID}/accept?t=${value}`, "POST"), environment, ctx);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /is now the approved version/);

  const changed = writes(executed);
  assert.ok(changed.some((entry) => /UPDATE change_notices SET state/.test(entry.sql) && entry.parameters[0] === "accepted"));
  // Without this the next release diffs against a version the reader already
  // approved, and the same notice arrives again.
  assert.ok(
    changed.some((entry) => /UPDATE watch_targets SET baseline_report_id/.test(entry.sql) && entry.parameters[0] === "c1"),
    "the candidate report did not become the baseline"
  );
});

test("the accept route exists only as a POST, and the read route only as a GET", async () => {
  const value = await token();
  for (const [path, method] of [
    [`/notice/${NOTICE_ID}/accept?t=${value}`, "GET"],
    [`/notice/${NOTICE_ID}?t=${value}`, "POST"]
  ] as const) {
    const { env: environment, executed } = env();
    const response = await worker.fetch(request(path, method), environment, ctx);
    assert.equal(response.status, 404, `${method} ${path} answered`);
    assert.deepEqual(writes(executed), []);
  }
});

/**
 * Several releases can be outstanding at once, each with its own notice, all
 * measured against the same approved version. Accepting them in inbox order means
 * accepting an older one last — and an unconditional `setBaseline` would walk the
 * approved version backwards, reopening the repeat chain the accept was closing.
 *
 * Found while clearing a real backlog: five notices for one package, every one of
 * them proposing a different candidate against the same baseline.
 */
test("accepting an older notice does not move the baseline backwards", async () => {
  // c2 arrived after this notice's candidate c1, and is already approved.
  const { env: environment, executed } = env({ baselineReportId: "c2" });
  const response = await worker.fetch(request(`/notice/${NOTICE_ID}/accept?t=${await token()}`, "POST"), environment, ctx);
  assert.equal(response.status, 200);

  const changed = writes(executed);
  assert.ok(
    changed.some((entry) => /UPDATE change_notices SET state/.test(entry.sql) && entry.parameters[0] === "accepted"),
    "the decision itself must still be recorded"
  );
  assert.ok(
    !changed.some((entry) => /UPDATE watch_targets SET baseline_report_id/.test(entry.sql)),
    "the approved version was walked backwards to an older release"
  );

  const body = await response.text();
  assert.match(body, /stays at <strong>2\.1\.0<\/strong>/, "the page states what is actually approved");
  assert.doesNotMatch(body, /2\.0\.0<\/strong> is now the approved version/);
});

test("accepting the same notice twice does not rewrite the baseline", async () => {
  // The target already points at this notice's candidate.
  const { env: environment, executed } = env({ baselineReportId: "c1" });
  await worker.fetch(request(`/notice/${NOTICE_ID}/accept?t=${await token()}`, "POST"), environment, ctx);
  assert.ok(!writes(executed).some((entry) => /UPDATE watch_targets/.test(entry.sql)));
});

test("a link accept does not overturn a decision made through the operator route", async () => {
  const frozen = { ...NOTICE, state: "frozen" as const, decided_at: "2026-08-09T00:00:00.000Z" };
  const { env: environment, executed } = env({ notice: frozen });
  const response = await worker.fetch(request(`/notice/${NOTICE_ID}/accept?t=${await token()}`, "POST"), environment, ctx);

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /frozen/, "the page reports the decision that actually stands");
  assert.doesNotMatch(body, /is now the approved version/);
  assert.deepEqual(writes(executed), [], "a later click overrode a considered freeze");
});

test("no signing secret means the routes do not exist", async () => {
  // A customer-reachable route whose signing secret is missing must not fall back
  // to serving anything. The token below is genuinely valid under SECRET.
  const value = await token();
  for (const [path, method] of [
    [`/notice/${NOTICE_ID}?t=${value}`, "GET"],
    [`/notice/${NOTICE_ID}/accept?t=${value}`, "POST"]
  ] as const) {
    const { env: environment, executed } = env({ secret: undefined });
    const response = await worker.fetch(request(path, method), environment, ctx);
    assert.equal(response.status, 404, `${method} ${path} answered with no secret configured`);
    assert.equal(executed.length, 0);
  }
});

test("the capability route did not open the operator gate", async () => {
  // The notice routes sit above `verifyApiKey` and authenticate for themselves.
  // Everything below the line must still be unreachable without the key.
  for (const path of ["/api/targets", "/api/notices", `/api/notices/${NOTICE_ID}/decision`]) {
    const { env: environment } = env();
    const response = await worker.fetch(request(path), environment, ctx);
    assert.equal(response.status, 401, `${path} answered without a key`);
  }
});

test("a notice id that is not a uuid is not a route", async () => {
  const { env: environment, executed } = env();
  const response = await worker.fetch(request(`/notice/../api/targets?t=${await token()}`), environment, ctx);
  assert.equal(response.status, 401, "an unmatched path falls through to the gate, not to a notice");
  assert.equal(executed.length, 0);
});
