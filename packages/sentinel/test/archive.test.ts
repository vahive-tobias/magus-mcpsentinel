import assert from "node:assert/strict";
import test from "node:test";
import { readNpmArchiveBytes } from "../src/archive.js";
import { createNpmTarball, createRawTarball, paxRecords } from "./archive-fixture.js";

const MANIFEST = { name: "package/package.json", contents: JSON.stringify({ name: "fixture", version: "1.0.0" }) };

// npm's own packer emits a GNU long-name entry when a path exceeds the 100-byte
// header field. Sentinel previously threw on the "L" type flag, which would have
// failed the whole analysis for any package with a deeply nested file.
test("resolves a GNU long-name entry into the following entry's path", () => {
  const longPath = `package/${"nested/".repeat(15)}deeply-buried-module.js`;
  assert.ok(longPath.length > 100, "fixture must exceed the 100-byte name field");

  const archive = readNpmArchiveBytes(createRawTarball([
    { name: "././@LongLink", contents: `${longPath}\0`, typeFlag: "L" },
    { name: longPath.slice(0, 99), contents: "export const value = 1;" },
    MANIFEST
  ]));

  const entry = archive.entries.find((item) => item.path === longPath);
  assert.ok(entry, "long path should be recovered from the @LongLink entry");
  assert.equal(entry?.contents?.toString("utf8"), "export const value = 1;");
  assert.equal(archive.entries.some((item) => item.path.includes("@LongLink")), false);
});

test("resolves a pax extended header path override", () => {
  const longPath = `package/${"segment/".repeat(14)}pax-named-module.js`;

  const archive = readNpmArchiveBytes(createRawTarball([
    { name: "PaxHeader/pax-named-module.js", contents: paxRecords({ path: longPath }), typeFlag: "x" },
    { name: "package/placeholder.js", contents: "export const value = 2;" },
    MANIFEST
  ]));

  const entry = archive.entries.find((item) => item.path === longPath);
  assert.ok(entry, "pax path record should override the header name");
  assert.equal(entry?.contents?.toString("utf8"), "export const value = 2;");
  assert.equal(archive.entries.some((item) => item.path.includes("PaxHeader")), false);
});

test("consumes a pax global header without contributing an entry", () => {
  const archive = readNpmArchiveBytes(createRawTarball([
    { name: "pax_global_header", contents: paxRecords({ comment: "abc123" }), typeFlag: "g" },
    MANIFEST,
    { name: "package/index.js", contents: "export {};" }
  ]));

  assert.deepEqual(archive.entries.map((item) => item.path).sort(), ["package/index.js", "package/package.json"]);
});

test("consumes a GNU long link entry without contributing an entry", () => {
  const archive = readNpmArchiveBytes(createRawTarball([
    { name: "././@LongLink", contents: `package/${"x".repeat(120)}\0`, typeFlag: "K" },
    MANIFEST
  ]));

  assert.deepEqual(archive.entries.map((item) => item.path), ["package/package.json"]);
});

test("keeps the stream aligned when metadata entries precede many files", () => {
  const longPath = `package/${"a/".repeat(60)}end.js`;
  const archive = readNpmArchiveBytes(createRawTarball([
    MANIFEST,
    { name: "././@LongLink", contents: `${longPath}\0`, typeFlag: "L" },
    { name: "package/placeholder.js", contents: "one" },
    { name: "package/second.js", contents: "two" },
    { name: "package/third.js", contents: "three" }
  ]));

  assert.deepEqual(archive.entries.map((item) => item.path).sort(), [
    longPath,
    "package/package.json",
    "package/second.js",
    "package/third.js"
  ].sort());
  assert.equal(archive.entries.find((item) => item.path === "package/third.js")?.contents?.toString("utf8"), "three");
});

// A path override still has to clear the same safety checks as a header name;
// otherwise a long-name entry would be a path-traversal bypass.
test("rejects a traversal path smuggled through a GNU long-name entry", () => {
  assert.throws(() => readNpmArchiveBytes(createRawTarball([
    { name: "././@LongLink", contents: "package/../../etc/passwd\0", typeFlag: "L" },
    { name: "package/placeholder.js", contents: "bad" },
    MANIFEST
  ])), /Unsafe archive path/);
});

test("rejects a path outside the package root smuggled through a pax header", () => {
  assert.throws(() => readNpmArchiveBytes(createRawTarball([
    { name: "PaxHeader/x", contents: paxRecords({ path: "elsewhere/evil.js" }), typeFlag: "x" },
    { name: "package/placeholder.js", contents: "bad" },
    MANIFEST
  ])), /outside the package root/);
});

// The reader resolves a duplicate path first-wins, while tar and npm extract
// last-wins. A benign first `package/package.json` could otherwise hide a second
// one carrying a postinstall: the report would derive metadata, dependencies and
// the lifecycle-script finding from the first (clean) entry while the installer
// runs the second. A duplicate path is a hostile/malformed construct and must
// fail closed, never yield a clean report about only the first entry.
test("rejects an archive with a duplicate package.json (reader first-wins vs installer last-wins)", () => {
  const benign = JSON.stringify({ name: "evil-mcp", version: "1.0.0" });
  const malicious = JSON.stringify({ name: "evil-mcp", version: "1.0.0", scripts: { postinstall: "node -e \"/* attacker */\"" } });
  assert.throws(() => readNpmArchiveBytes(createRawTarball([
    { name: "package/package.json", contents: benign },
    { name: "package/index.js", contents: "export {};" },
    { name: "package/package.json", contents: malicious }
  ])), /duplicate entry path/);
});

test("rejects an archive that ends with an unconsumed long-name entry", () => {
  assert.throws(() => readNpmArchiveBytes(createRawTarball([
    MANIFEST,
    { name: "././@LongLink", contents: "package/dangling.js\0", typeFlag: "L" }
  ])), /describes no entry/);
});

test("still rejects a genuinely unsupported tar entry type", () => {
  assert.throws(() => readNpmArchiveBytes(createRawTarball([
    MANIFEST,
    { name: "package/sparse.bin", contents: "data", typeFlag: "S" }
  ])), /Unsupported tar entry type/);
});

test("reads a plain ustar archive unchanged", () => {
  const archive = readNpmArchiveBytes(createNpmTarball({
    "package/package.json": MANIFEST.contents,
    "package/index.js": "export {};"
  }));
  assert.deepEqual(archive.entries.map((item) => item.path).sort(), ["package/index.js", "package/package.json"]);
});
