import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { readNpmArchive, preserveAcquisitionEvidence } from "../src/node-io.js";
import { acquireNpmPackage, parseNpmSpecifier } from "../src/npm-registry.js";
import { createStaticReport } from "../src/report.js";
import { validateReport } from "../src/schema.js";
import { createNpmTarball } from "./archive-fixture.js";

const execFile = promisify(execFileCallback);

async function fixturePath(entries: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-test-"));
  const archive = createNpmTarball(entries);
  const path = join(directory, "fixture.tgz");
  await writeFile(path, archive);
  return path;
}

test("creates a schema-valid static report for an npm tarball", async () => {
  const packageJson = JSON.stringify({
    name: "@fixture/basic-mcp",
    version: "1.0.0",
    mcpName: "io.fixture/basic",
    dependencies: { zeta: "1.0.0", alpha: "2.0.0" }
  });
  const path = await fixturePath({
    "package/package.json": packageJson,
    "package/index.js": "import { readFile } from 'node:fs'; export const value = readFile('x');"
  });

  const archive = await readNpmArchive(path);
  const report = await createStaticReport(archive);
  await validateReport(report);

  assert.equal(report.format_version, "0.2.0");
  assert.equal((report.subject as { artifact: { sha256: string } }).artifact.sha256, createHash("sha256").update(archive.compressed).digest("hex"));
  assert.equal((report.subject as { server_name: string }).server_name, "io.fixture/basic");
  assert.ok((report.observations as unknown[]).length >= 3);
  assert.deepEqual((report.findings as unknown[]), []);
});

test("rejects an archive containing a path outside package root", async () => {
  const path = await fixturePath({
    "../outside.txt": "not allowed",
    "package/package.json": JSON.stringify({ name: "fixture", version: "1.0.0" })
  });
  await assert.rejects(readNpmArchive(path), /Unsafe archive path/);
});

test("rejects an archive without package metadata", async () => {
  const path = await fixturePath({ "package/index.js": "export {};" });
  const archive = await readNpmArchive(path);
  await assert.rejects(createStaticReport(archive), /package\/package\.json/);
});

test("CLI writes a pretty, schema-valid report", async () => {
  const path = await fixturePath({
    "package/package.json": JSON.stringify({ name: "fixture-cli", version: "1.0.0" }),
    "package/index.js": "export {};"
  });
  const output = join(await mkdtemp(join(tmpdir(), "sentinel-cli-test-")), "report.json");
  const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const result = await execFile(process.execPath, [cliPath, "analyze", path, "--output", output, "--pretty"]);
  const report = JSON.parse(await readFile(output, "utf8")) as unknown;

  assert.match(result.stdout, /Wrote schema-valid Sentinel report/);
  await validateReport(report);
});

test("acquires a pinned npm version, verifies it, and preserves exact evidence", async () => {
  const tarball = createNpmTarball({
    "package/package.json": JSON.stringify({ name: "@fixture/registry-mcp", version: "1.2.3" }),
    "package/index.js": "export {};"
  });
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const metadata = Buffer.from(JSON.stringify({
    name: "@fixture/registry-mcp",
    version: "1.2.3",
    dist: { tarball: "https://tarballs.example/registry-mcp-1.2.3.tgz", integrity }
  }), "utf8");
  const requestedUrls: string[] = [];
  const fetcher = async (input: string): Promise<Response> => {
    requestedUrls.push(input);
    if (input === "https://registry.example/%40fixture%2Fregistry-mcp/1.2.3") {
      return new Response(new Uint8Array(metadata), { status: 200, headers: { "content-length": String(metadata.length) } });
    }
    if (input === "https://tarballs.example/registry-mcp-1.2.3.tgz") {
      return new Response(new Uint8Array(tarball), { status: 200, headers: { "content-length": String(tarball.length) } });
    }
    return new Response("not found", { status: 404 });
  };

  const acquisition = await acquireNpmPackage(parseNpmSpecifier("@fixture/registry-mcp@1.2.3"), "https://registry.example", fetcher);
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "sentinel-evidence-test-"));
  const evidence = await preserveAcquisitionEvidence(acquisition, evidenceDirectory);
  const report = await createStaticReport(await readNpmArchive(evidence.tarballPath), {
    requestedPackage: acquisition.request.packageName,
    requestedVersion: acquisition.request.version,
    acquiredAt: acquisition.acquiredAt,
    metadataUrl: acquisition.metadataUrl,
    metadataSha256: acquisition.metadataSha256,
    tarballUrl: acquisition.tarballUrl,
    integrityClaim: acquisition.integrityClaim,
    integrityVerified: acquisition.integrityVerified
  });

  await validateReport(report);
  assert.deepEqual(requestedUrls, [
    "https://registry.example/%40fixture%2Fregistry-mcp/1.2.3",
    "https://tarballs.example/registry-mcp-1.2.3.tgz"
  ]);
  assert.deepEqual(await readFile(evidence.metadataPath), metadata);
  assert.deepEqual(await readFile(evidence.tarballPath), tarball);
  assert.equal((report.subject as { artifact: { integrity_verified: boolean } }).artifact.integrity_verified, true);
});

test("rejects a tarball that does not match the registry integrity claim", async () => {
  const tarball = createNpmTarball({ "package/package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  const metadata = JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    dist: { tarball: "https://tarballs.example/fixture-1.0.0.tgz", integrity: "sha512-AAAAAAAA" }
  });
  const fetcher = async (input: string): Promise<Response> => new Response(
    input.includes("tarballs.example") ? new Uint8Array(tarball) : metadata,
    { status: 200 }
  );

  await assert.rejects(
    acquireNpmPackage(parseNpmSpecifier("fixture@1.0.0"), "https://registry.example", fetcher),
    /does not match the registry integrity claim/
  );
});
