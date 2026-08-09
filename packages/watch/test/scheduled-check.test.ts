import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkForNewReleases } from "../src/worker.js";
import { WatchRepository } from "../src/repository.js";
import type { Env, WatchTargetRecord } from "../src/types.js";

/**
 * The scheduled check now runs the analyzer itself rather than posting a job to a
 * separate service. What matters is not that analysis succeeds — it is what the
 * monitor records when it does not.
 *
 * The rule these cover: `last_seen_version` is the monitor's memory of what it has
 * examined. Advancing it for a release that was never analyzed converts "we could
 * not look" into "nothing changed", which is the only wrong answer a change
 * monitor can give.
 */

interface Recorded {
  targetId: string;
  status: string;
  version: string | null;
  detail: string | null;
}

function target(id: string, packageName: string, lastSeen: string | null): WatchTargetRecord {
  return {
    id,
    account_id: "account-1",
    package_name: packageName,
    package_spec: "latest",
    enabled: 1,
    baseline_report_id: null,
    last_seen_version: lastSeen,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z"
  };
}

/**
 * Tracks check_runs as the Worker leaves them: a row is inserted before analysis
 * starts and updated with the outcome, so a test must follow the update to see the
 * final status. An untouched `queued` row is exactly what an interrupted run
 * leaves behind, which is the behaviour these tests exist to pin down.
 */
function fakeEnv(targets: WatchTargetRecord[], overrides: Partial<Env> = {}) {
  const byId = new Map<string, Recorded>();
  const watermarkWrites: string[] = [];

  const database = {
    prepare(sql: string) {
      const statement = {
        bind(...bound: unknown[]) {
          if (sql.includes("INSERT INTO check_runs")) {
            byId.set(String(bound[0]), {
              targetId: String(bound[1]),
              status: String(bound[2]),
              version: bound[3] === null ? null : String(bound[3]),
              detail: bound[4] === null ? null : String(bound[4])
            });
          }
          if (sql.includes("UPDATE check_runs SET status")) {
            const existing = byId.get(String(bound[2]));
            if (existing) {
              existing.status = String(bound[0]);
              existing.detail = String(bound[1]);
            }
          }
          if (sql.includes("UPDATE watch_targets SET last_seen_version")) {
            watermarkWrites.push(String(bound[0]));
          }
          return statement;
        },
        async first() { return null; },
        async run() { return { success: true }; },
        async all() { return { results: targets }; }
      };
      return statement;
    }
  };

  const env = { DB: database, OPERATOR_API_KEY: "k", ANALYZER_INGEST_SECRET: "s", ...overrides } as unknown as Env;
  return { env, checks: byId, watermarkWrites };
}

function checkList(checks: Map<string, Recorded>): Recorded[] {
  return [...checks.values()];
}

/** A gzip member whose ISIZE trailer declares far more than any Worker can hold. */
function oversizedArtifact(): ArrayBuffer {
  const artifact = Buffer.from(gzipSync(Buffer.from("not really a tarball")));
  artifact.writeUInt32LE(900 * 1024 * 1024, artifact.byteLength - 4);
  const copy = new Uint8Array(artifact.byteLength);
  copy.set(artifact);
  return copy.buffer;
}

function stubFetch(handler: (url: string) => Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => handler(String(input))) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function registryMetadata(packageName: string, version: string, tarballUrl: string): Response {
  return new Response(JSON.stringify({ name: packageName, version, dist: { tarball: tarballUrl } }), {
    headers: { "content-type": "application/json" }
  });
}

test("records a skipped check and analyzes nothing when the version has not moved", async () => {
  const { env, checks: checkMap, watermarkWrites } = fakeEnv([target("t1", "left-pad-mcp", "1.0.0")]);
  const restore = stubFetch((url) => {
    assert.ok(url.endsWith("/latest"), `only the version probe should be fetched, got ${url}`);
    return registryMetadata("left-pad-mcp", "1.0.0", "https://registry.npmjs.org/x/-/x-1.0.0.tgz");
  });

  try {
    await checkForNewReleases(env);
  } finally {
    restore();
  }

  const checks = checkList(checkMap);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.status, "skipped");
  assert.deepEqual(watermarkWrites, [], "an unchanged version must not rewrite the watermark");
});

test("an artifact too large to analyze is recorded as failed, and the watermark stays put", async () => {
  const { env, checks: checkMap, watermarkWrites } = fakeEnv([target("t1", "huge-mcp", "1.0.0")]);
  const artifact = oversizedArtifact();
  const restore = stubFetch((url) =>
    url.endsWith("/latest") || url.endsWith("/2.0.0")
      ? registryMetadata("huge-mcp", "2.0.0", "https://registry.npmjs.org/huge-mcp/-/huge-mcp-2.0.0.tgz")
      : new Response(artifact, { headers: { "content-type": "application/octet-stream" } }));

  try {
    await checkForNewReleases(env);
  } finally {
    restore();
  }

  const failure = checkList(checkMap).find((check) => check.status === "failed");
  assert.ok(failure, `expected a failed check, got ${JSON.stringify(checkList(checkMap))}`);
  assert.equal(failure?.version, "2.0.0", "the failure must name the release it could not cover");
  assert.match(String(failure?.detail), /exceeds this deployment's \d+ byte decompressed limit/);

  assert.deepEqual(watermarkWrites, [], "an unanalyzed release must never be marked as seen");
});

test("a registry failure is recorded as failed rather than as no change", async () => {
  const { env, checks: checkMap, watermarkWrites } = fakeEnv([target("t1", "gone-mcp", "1.0.0")]);
  const restore = stubFetch(() => new Response("not found", { status: 404 }));

  try {
    await checkForNewReleases(env);
  } finally {
    restore();
  }

  const checks = checkList(checkMap);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.status, "failed");
  assert.deepEqual(watermarkWrites, []);
});

// Analysis costs far more CPU than a Workers Free invocation is given, so a
// free-plan deployment turns it off and posts reports to /api/reports instead. The
// release must still be recorded as outstanding, never as checked.
test("with in-Worker analysis disabled, a new release is recorded as awaiting a report", async () => {
  const { env, checks: checkMap, watermarkWrites } = fakeEnv(
    [target("t1", "left-pad-mcp", "1.0.0")],
    { ANALYZE_IN_WORKER: "false" }
  );
  const restore = stubFetch((url) => {
    assert.ok(!url.includes(".tgz"), `no artifact should be downloaded, got ${url}`);
    return registryMetadata("left-pad-mcp", "2.0.0", "https://registry.npmjs.org/x/-/x-2.0.0.tgz");
  });

  try {
    await checkForNewReleases(env);
  } finally {
    restore();
  }

  const checks = checkList(checkMap);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.status, "queued");
  assert.equal(checks[0]?.version, "2.0.0");
  assert.match(String(checks[0]?.detail), /\/api\/reports/);
  assert.deepEqual(watermarkWrites, [], "a detected but unanalyzed release is not yet seen");
});

// An invocation killed by the platform CPU limit never reaches a completion
// statement. The row written before analysis is the only evidence that survives,
// so it must already name the version and explain the symptom.
test("the check written before analysis names the version and the CPU-limit symptom", async () => {
  const { env, checks: checkMap } = fakeEnv([target("t1", "huge-mcp", "1.0.0")]);
  const artifact = oversizedArtifact();
  const restore = stubFetch((url) =>
    url.includes(".tgz")
      ? new Response(artifact, { headers: { "content-type": "application/octet-stream" } })
      : registryMetadata("huge-mcp", "2.0.0", "https://registry.npmjs.org/huge-mcp/-/huge-mcp-2.0.0.tgz"));

  const inserted: string[] = [];
  const originalPrepare = (env.DB as unknown as { prepare: (sql: string) => unknown }).prepare;
  (env.DB as unknown as { prepare: (sql: string) => unknown }).prepare = function (sql: string) {
    if (sql.includes("INSERT INTO check_runs")) inserted.push(sql);
    return (originalPrepare as (s: string) => unknown).call(this, sql);
  };

  try {
    await checkForNewReleases(env);
  } finally {
    restore();
  }

  assert.equal(inserted.length, 1, "the intent row must be written before analysis, exactly once");
  const check = checkList(checkMap)[0];
  assert.ok(check, "a check row must exist");
  assert.equal(check?.version, "2.0.0", "the row written first already names the version");
});

// A first run has every target needing a baseline at once. The per-run budget
// bounds that work; the targets it defers keep their watermark, so the next run
// picks them up rather than losing them.
test("work beyond the per-run budget is deferred, not dropped", async () => {
  const targets = Array.from({ length: 11 }, (_, index) => target(`t${index}`, `pkg-${index}-mcp`, "1.0.0"));
  const { env, checks: checkMap, watermarkWrites } = fakeEnv(targets);
  const artifact = oversizedArtifact();
  const restore = stubFetch((url) =>
    url.includes(".tgz")
      ? new Response(artifact, { headers: { "content-type": "application/octet-stream" } })
      : registryMetadata(url.split("/").slice(-2)[0] ?? "pkg-0-mcp", "2.0.0", "https://registry.npmjs.org/p/-/p-2.0.0.tgz"));

  try {
    await checkForNewReleases(env);
  } finally {
    restore();
  }

  const checks = checkList(checkMap);
  const attempted = checks.filter((check) => check.status === "failed").length;
  const deferred = checks.filter((check) => check.status === "queued").length;

  assert.equal(attempted + deferred, 11, "every target must be accounted for");
  assert.ok(attempted > 0 && deferred > 0, `expected some analyzed and some deferred, got ${attempted}/${deferred}`);
  assert.ok(checks.every((check) => check.version === "2.0.0"), "each record names the observed version");
  assert.deepEqual(watermarkWrites, []);
});

// The hybrid pipeline hands work to an analyzer running elsewhere. Only the most
// recent check decides: a target already analyzed, or failed for another reason,
// must not be handed out again.
test("pending analyses are the targets whose latest check is still queued", async () => {
  const rows = [{ target_id: "t1", package_name: "pending-mcp", observed_version: "2.0.0" }];
  const statements: string[] = [];
  const database = {
    prepare(sql: string) {
      statements.push(sql);
      const statement = {
        bind: () => statement,
        first: async () => null,
        run: async () => ({ success: true }),
        all: async () => ({ results: rows })
      };
      return statement;
    }
  };

  const repository = new WatchRepository(database as unknown as D1Database);
  const pending = await repository.listPendingAnalyses();

  assert.deepEqual(pending, [{ targetId: "t1", packageName: "pending-mcp", version: "2.0.0" }]);

  const query = statements.join(" ");
  assert.match(query, /status = 'queued'/, "only a queued check counts as pending");
  assert.match(query, /ORDER BY created_at DESC, id DESC LIMIT 1/, "only the latest check per target is consulted");
  assert.match(query, /t\.enabled = 1/, "a disabled target is never handed out");
});

// Regression: the first version of this query keyed only on the latest check's
// status. A report arriving through /api/reports is not a check, so the queued
// row stayed queued and the same release was handed to the analyzer on every
// poll, forever. The existence of a report for that version is what decides it.
test("a release with a report already stored is no longer pending", async () => {
  const statements: string[] = [];
  const database = {
    prepare(sql: string) {
      statements.push(sql);
      const statement = {
        bind: () => statement,
        first: async () => null,
        run: async () => ({ success: true }),
        all: async () => ({ results: [] })
      };
      return statement;
    }
  };

  const repository = new WatchRepository(database as unknown as D1Database);
  await repository.listPendingAnalyses();

  const query = statements.join(" ").replace(/\s+/g, " ");
  assert.match(
    query,
    /NOT EXISTS \( SELECT 1 FROM analysis_reports r WHERE r\.target_id = t\.id AND r\.package_version = c\.observed_version \)/,
    "pending must exclude releases that already have a report, or work is redelivered forever"
  );
});

// Regression: deliverOutstandingNotices was written and never called. TypeScript
// does not complain about an unused function, so it compiled clean and silently
// retried nothing. An end-to-end run caught it; this keeps it caught.
test("the scheduled check retries notices that were never delivered", async () => {
  // The compiled module, not the source: this asserts the call survives into what
  // actually ships, which is the thing that was missing.
  const source = readFileSync(fileURLToPath(new URL("../src/worker.js", import.meta.url)), "utf8");
  const scheduled = source.slice(source.indexOf("export async function checkForNewReleases"));
  const body = scheduled.slice(0, scheduled.indexOf("\n}\n"));
  assert.match(
    body,
    /await deliverOutstandingNotices\(env, repository\)/,
    "a notice that failed to send is only ever retried from the scheduled check"
  );
});
