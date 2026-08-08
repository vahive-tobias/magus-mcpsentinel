import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { ArchiveTooLargeError, readNpmArchiveBytes } from "../src/archive.js";
import { ANALYZER_BUILD_SHA256 } from "../src/build-info.js";
import { acquireNpmPackage } from "../src/npm-registry.js";
import { createStaticReport } from "../src/report.js";
import { validateReport, ReportValidationError } from "../src/schema.js";
import { createNpmTarball } from "./archive-fixture.js";

/**
 * The analyzer runs in hosts without a filesystem, where it has far less memory
 * than the default bounds allow. These cover the three things that change about
 * it there: a caller-supplied size limit, a build identity that is not read from
 * disk, and schema validation that is not compiled at runtime.
 */

const MANIFEST = JSON.stringify({ name: "fixture", version: "1.0.0" });

test("a caller with less memory can lower the decompressed-size limit", () => {
  const archive = createNpmTarball({ "package/package.json": MANIFEST });

  assert.ok(readNpmArchiveBytes(archive).entries.length > 0, "the default limit accepts an ordinary archive");

  assert.throws(
    () => readNpmArchiveBytes(archive, { maxUncompressedBytes: 512 }),
    ArchiveTooLargeError,
    "an archive above the caller's limit is refused"
  );
});

// An artifact too large for this host and an artifact that is malformed are
// different facts. Reporting the second as the first would attribute a limit of
// the deployment to the package.
test("an archive that is merely too large is distinguishable from a corrupt one", () => {
  const tooLarge = createNpmTarball({ "package/package.json": MANIFEST, "package/big.js": "x".repeat(4096) });
  assert.throws(() => readNpmArchiveBytes(tooLarge, { maxUncompressedBytes: 1024 }), ArchiveTooLargeError);

  // Valid gzip framing over a damaged deflate stream: it survives the size check
  // and fails in the decompressor, which is the path a real corrupt artifact takes.
  const corrupt = Buffer.from(gzipSync(Buffer.alloc(2048, 0x41)));
  for (let offset = 10; offset < Math.min(corrupt.length - 8, 24); offset += 1) {
    corrupt[offset] = (corrupt[offset] ?? 0) ^ 0xff;
  }

  assert.throws(
    () => readNpmArchiveBytes(corrupt),
    (error: unknown) => error instanceof Error && !(error instanceof ArchiveTooLargeError),
    "a corrupt archive must not be reported as an oversized one"
  );
});

test("the refusal states the limit that was applied", () => {
  const archive = createNpmTarball({ "package/package.json": MANIFEST });
  try {
    readNpmArchiveBytes(archive, { maxUncompressedBytes: 256 });
    assert.fail("expected the archive to be refused");
  } catch (error) {
    assert.ok(error instanceof ArchiveTooLargeError);
    assert.equal(error.limit, 256);
  }
});

// Acquisition asked for `redirect: "error"`, which edge runtimes do not implement
// — it failed every fetch in a Worker. The replacement must still refuse the
// redirect rather than quietly follow it somewhere the URL checks already rejected.
test("a redirected registry response is refused, not followed", async () => {
  const seen: RequestInit[] = [];
  const redirectingFetch = async (_url: string, init?: RequestInit) => {
    seen.push(init ?? {});
    return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/evil.tgz" } });
  };

  await assert.rejects(
    () => acquireNpmPackage({ packageName: "fixture", version: "1.0.0" }, "https://registry.npmjs.org", redirectingFetch),
    /redirected/,
    "a 3xx must abort acquisition"
  );

  assert.equal(seen[0]?.redirect, "manual", "the request must not ask the runtime to follow redirects");
});

// The build identity used to be the hash of a source file read at runtime, which
// a bundled analyzer cannot do. It is now fixed at build time and must still
// satisfy the schema's digest shape.
test("the analyzer build identity is a digest fixed at build time", async () => {
  assert.match(ANALYZER_BUILD_SHA256, /^[a-f0-9]{64}$/);

  const report = await createStaticReport(readNpmArchiveBytes(createNpmTarball({ "package/package.json": MANIFEST })));
  const analysis = report.analysis as { engine: { build_sha256: string; name: string } };
  assert.equal(analysis.engine.build_sha256, ANALYZER_BUILD_SHA256);
  assert.equal(analysis.engine.name, "sentinel");
});

// The validator is precompiled because a Worker refuses to evaluate generated
// source. A precompiled validator that accepted anything would pass every other
// test in this suite silently.
test("the precompiled validator still rejects a non-conforming report", async () => {
  const report = await createStaticReport(readNpmArchiveBytes(createNpmTarball({ "package/package.json": MANIFEST })));
  await validateReport(report);

  await assert.rejects(
    () => validateReport({ ...report, format_version: "0.1.0" }),
    ReportValidationError,
    "a wrong format version must not validate"
  );
  await assert.rejects(() => validateReport({}), ReportValidationError);
  await assert.rejects(
    () => validateReport({ ...report, analysis: { ...(report.analysis as object), engine: { name: "sentinel", version: "0.2.0", build_sha256: "not-a-digest" } } }),
    ReportValidationError,
    "a malformed digest must not validate"
  );
});
