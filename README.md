# Sentinel

**Deterministic, non-executing evidence and change monitoring for public npm MCP servers.**

Sentinel unpacks an exact npm artifact, inspects it without running any of it, and
emits a schema-validated JSON report describing what that artifact declares. It can
compare two reports and tell you what changed. And it can watch a package over time
and tell you when something you approved has moved.

It does **not** decide whether a package is safe. It produces evidence; you set the
policy.

Free and open source, in full. There is no withheld tier.

```sh
sentinel analyze ./server-filesystem-2026.7.10.tgz --output report.json
sentinel diff old-report.json new-report.json
```

```text
@modelcontextprotocol/server-filesystem: 2026.1.14 -> 2026.7.10
5 change(s):
  [artifact_changed] Artifact digest changed: e5635c070c21… → c17c1da371c8….
  [dependency_changed] Changed runtime dependency @modelcontextprotocol/sdk: ^1.25.2 → ^1.29.0.
  [dependency_removed] Removed runtime dependency zod-to-json-schema@^3.23.5.
  [tool_description_changed] Tool read_media_file description changed.
```

## Why

An MCP server you installed once can become materially different over a few
releases: a new tool, a widened input schema, an added install-time script, a
changed description that the model reads as an instruction. Registries make
versions discoverable; they do not tell you what changed inside one.

Sentinel turns a versioned artifact into a comparable evidence record.

## Packages

| Package | What it is |
| --- | --- |
| [`packages/sentinel`](packages/sentinel) | The analyzer and `sentinel` CLI. Produces evidence reports and compares them. |
| [`packages/watch`](packages/watch) | A self-hosted monitor. Polls packages you choose, runs the analyzer on new releases, and raises a reviewable change notice. Single-tenant: you deploy it, you hold the data. |

The dependency runs one way. The analyzer does not know the monitor exists.

## Quick start

Requires Node.js 22 or later.

```sh
npm install
npm run build
npm test

node packages/sentinel/dist/src/cli.js analyze ./package.tgz --output report.json --pretty
```

Acquire and analyze an exact published version, preserving the raw inputs:

```sh
node packages/sentinel/dist/src/cli.js analyze npm @scope/package@1.2.3 \
  --evidence-dir ./evidence --output report.json --pretty
```

The evidence directory receives the registry's unmodified version metadata and the
downloaded tarball, each named by its SHA-256. Sentinel verifies the registry's
`dist.integrity` claim when one is published and refuses a mismatch.

## What a report contains

Schema: [`packages/sentinel/schemas/report.schema.json`](packages/sentinel/schemas/report.schema.json) (format `0.2.0`).

- **Artifact identity** — package, version, SHA-256, acquisition evidence.
- **Package metadata** — entrypoints, scripts, engines, declared server name.
- **File inventory** — every entry with a per-file digest.
- **Runtime dependencies** as declared.
- **Static API indicators** — network, filesystem and process-spawning references.
- **Tool inventory** — statically inferred tool names, with digests of each input
  schema and description.
- **Findings** — rule matches, each linked to evidence by digest and byte range.
- **Limitations** — what this particular analysis could not establish.

Re-analyzing the same artifact produces byte-identical observations.

## What it deliberately does not do

Sentinel never executes package code, never accepts credentials, never opens an MCP
protocol session, and never assigns a safety verdict. The tool inventory is
recovered by parsing source, so it is **inference and it is incomplete** — a usable
inventory was recovered for 32% of a 25-package real-world corpus.

**[docs/LIMITATIONS.md](docs/LIMITATIONS.md) states the boundaries in full. Read it
before relying on a report.**

Change classes are facts, not rankings. `sentinel diff` reports *what* changed and
assigns no severity, because ranking a change is policy. The monitor applies its own
severity mapping on top; you can replace it.

## Reference

- [Report schema](packages/sentinel/schemas/report.schema.json) — the output contract.
- [Limitations](docs/LIMITATIONS.md) — what Sentinel cannot detect.
- [Protocol profile](docs/PROTOCOL_PROFILE_2026-07-28.md) — the MCP revision this build targets.
- [Spec provenance](docs/SPEC_PROVENANCE.md) — the specification snapshot the profile derives from, with digests.
- [Security](SECURITY.md) — threat model and how to report a vulnerability.

## Status

Early. The report format is versioned and will change; `format_version` is bumped
whenever it does, and old reports are never silently reinterpreted.

Maintained by its authors. Not currently accepting external contributions.

If you want help wiring this into your stack, or a review of what your MCP surface
actually looks like, that is something we offer as a paid service. The tool itself
stays free and complete.
