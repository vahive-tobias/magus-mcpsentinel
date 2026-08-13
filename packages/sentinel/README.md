# magus-mcpsentinel

**Deterministic, non-executing evidence reports for public npm MCP servers.**

Unpacks an exact published artifact, reads it without running any of it, and emits
a schema-validated JSON report describing what that artifact declares. Compares two
reports and states what changed.

It does **not** decide whether a package is safe. It produces evidence; you set the
policy.

See it working before installing anything: **[aivare.ai/watch](https://aivare.ai/watch)**
publishes real reports for real MCP servers, with the raw JSON downloadable so you
can fetch the same artifact from npm and hash it yourself.

## Use it

Requires Node.js 22 or later. Nothing to configure and no account anywhere.

```sh
npx magus-mcpsentinel analyze npm @modelcontextprotocol/server-filesystem@2026.7.10 --evidence-dir ./evidence --output report.json --pretty
```

That acquires the exact published version, verifies the registry's
`dist.integrity` claim, reads the artifact without running any of it, and writes a
schema-validated report.

Install it properly if you would rather have the `sentinel` command:

```sh
npm install -g magus-mcpsentinel
```

```sh
sentinel analyze ./server-filesystem-2026.7.10.tgz --output report.json --pretty
```

The evidence directory receives the registry's unmodified metadata and the
downloaded tarball, each named by its SHA-256. The registry's `dist.integrity`
claim is verified when one is published, and a mismatch is refused.

Compare two reports:

```sh
sentinel diff baseline.json candidate.json
```

```text
@upstash/context7-mcp: 3.2.5 -> 4.0.0
9 change(s):
  [artifact_changed] Artifact digest changed: eb801dc8b6f2… → 08118a6721df….
  [dependency_added] Added runtime dependency @modelcontextprotocol/node@2.0.0.
  [dependency_removed] Removed runtime dependency @modelcontextprotocol/sdk@^1.29.0.
  [dependency_added] Added runtime dependency @modelcontextprotocol/server@2.0.0.
  [dependency_removed] Removed runtime dependency @upstash/redis@^1.38.0.
  [tool_schema_changed] Tool query-docs input schema changed.
  [tool_schema_changed] Tool resolve-library-id input schema changed.
  [file_inventory_changed] File inventory changed: 0 added, 2 removed.
  [file_content_changed] 5 files changed contents without changing the inventory.
```

`--json` emits the same result as structured data.

## What a report contains

Schema: [`schemas/report.schema.json`](https://github.com/vahive-tobias/magus-mcpsentinel/blob/main/packages/sentinel/schemas/report.schema.json), format `0.2.0`.

- **Artifact identity** — package, version, SHA-256, acquisition evidence.
- **Package metadata** — entrypoints, scripts, engines, declared server name.
- **File inventory** — every entry with a per-file digest.
- **Runtime dependencies** as declared.
- **Static API indicators** — network, filesystem and process-spawning references.
- **Tool inventory** — statically inferred tool names, with digests of each input
  schema and description.
- **Findings** — rule matches, linked to evidence by digest and byte range.
- **Limitations** — what this particular analysis could not establish.

Re-analyzing the same artifact produces byte-identical observations.

## Importing it

Only portable modules are exported, so a consumer in a constrained runtime — an
edge worker, a browser — can import them. The CLI and the filesystem-backed
helpers are deliberately not exported.

```ts
import { analyzeNpmPackage } from "magus-mcpsentinel/analyze";
import { diffReports } from "magus-mcpsentinel/diff";
import { assertSentinelReport } from "magus-mcpsentinel/report-contract";
```

`analyzeNpmPackage` acquires, reads and validates in one call. It takes an optional
`maxUncompressedBytes` for hosts with less memory than the default bound allows;
exceeding it raises `ArchiveTooLargeError`, which a caller should record as a
coverage limit rather than a finding about the package.

## What it deliberately does not do

Never executes package code, never accepts credentials, never opens an MCP protocol
session, never assigns a safety verdict.

The tool inventory is recovered by parsing source, so it is **inference and it is
incomplete** — across a pinned 50-package corpus, **37 yielded a usable inventory
and 12 yielded one the extractor could resolve completely**. Both numbers are in
`corpus/metrics.json` and can be re-run. Everything else in a report — artifact
digest, file inventory, dependencies, scripts, entrypoints — is recorded
completely, on every package, every time.

`diff` reports *what* changed and assigns no severity, because ranking a change is
policy and belongs to whoever has to act on it.

**[docs/LIMITATIONS.md](https://github.com/vahive-tobias/magus-mcpsentinel/blob/main/docs/LIMITATIONS.md) states the boundaries in full,
including the five specific ways extraction fails. Read it before relying on a
report.**

## Report format

`format_version` is `0.2.0`. Reading is permissive and writing is exact: this build
emits `0.2.0` and validates its own output against a schema pinned to that version,
while `assertSentinelReport` also accepts `0.1.0` so older stored baselines stay
comparable.

A field change is a format version change, and old reports are never silently
reinterpreted.

## Licence

Apache 2.0. Part of the [Sentinel](https://github.com/vahive-tobias/magus-mcpsentinel) workspace, alongside
[`@sentinel/watch`](https://github.com/vahive-tobias/magus-mcpsentinel/blob/main/packages/watch), a self-hosted monitor built on this analyzer. The
dependency runs one way — this package has no knowledge of its consumers.
