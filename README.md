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
6 change(s):
  [artifact_changed] Artifact digest changed: e5635c070c21… → c17c1da371c8….
  [dependency_changed] Changed runtime dependency @modelcontextprotocol/sdk: ^1.25.2 → ^1.29.0.
  [dependency_changed] Changed runtime dependency diff: ^5.1.0 → ^8.0.3.
  [dependency_removed] Removed runtime dependency zod-to-json-schema@^3.23.5.
  [tool_description_changed] Tool read_media_file description changed.
  [file_content_changed] 6 files changed contents without changing the inventory.
```

## Why

An MCP server you installed once can become materially different over a few
releases: a new tool, a widened input schema, an added install-time script, a
changed description that the model reads as an instruction. Registries make
versions discoverable; they do not tell you what changed inside one.

Sentinel turns a versioned artifact into a comparable evidence record.

## Packages

| Package | What it is | What it needs |
| --- | --- | --- |
| [`packages/sentinel`](packages/sentinel) | The analyzer and `sentinel` CLI. Produces evidence reports and compares them. | Node.js 22+. Nothing else — no account, no service, no hosting. |
| [`packages/watch`](packages/watch) | A self-hosted monitor on Cloudflare Workers and D1. Polls packages you choose, analyzes new releases, and raises a reviewable change notice. Single-tenant: you deploy it, you hold the data. | Workers Free handles ordinary packages; ~US$5/month lifts the ceiling. |
| [`.sentinel-watch`](.sentinel-watch) | The same monitoring, run by GitHub Actions against committed baselines. | A GitHub repository. **No cost.** |

The dependency runs one way. The analyzer does not know the monitor exists.

## Monitoring a package over time — pick your hosting

Three ways to run the same analyzer and the same severity policy. **One of them
costs nothing**, and it is not a lesser version.

| | [Free — GitHub Actions](.sentinel-watch) | [Cloudflare Worker](packages/watch) |
| --- | --- | --- |
| **Cost** | **Nothing.** Unmetered on public repositories; ~2 min per run against the 2,000 min/month a private repository gets free. | Runs on Workers Free for ordinary packages; ~US$5/month lifts the ceiling. |
| Where state lives | Committed JSON files. Git is the report history. | D1. |
| How you review | A pull request. Merge accepts the new baseline; close keeps the old one. | An operator dashboard, or the API. |
| Package size limit | **None.** | 64 MB decompressed on a paid plan; around 11 MB unpacked on the free plan. |
| Scheduling | GitHub cron. Can be delayed under load, and pauses after 60 days of repository inactivity. | Cloudflare cron. |

The free option is not a teaser. It has *better* package coverage than the paid
one, because a GitHub runner is not confined to a Worker's 128 MB isolate — the two
largest real MCP packages analyze there and cannot analyze in a Worker at all.

```sh
# the entire free setup: fork, list your packages, enable Actions
echo '{ "packages": ["@modelcontextprotocol/server-filesystem"] }' > .sentinel-watch/watchlist.json
```

See [`.sentinel-watch/README.md`](.sentinel-watch) for the honest limits of the
free path, which are about scheduling, not capability.

### What the Cloudflare Worker does on a free plan

**More than expected.** Measured on a real Workers Free deployment, analyzing real
packages from the live registry:

| package | compressed | unpacked | entries | result |
| --- | ---: | ---: | ---: | --- |
| `@modelcontextprotocol/server-filesystem` | 18 KB | 69 KB | 7 | analyzed |
| `@salesforce/mcp` | 186 KB | 0.8 MB | 36 | analyzed |
| `@notionhq/notion-mcp-server` | 1.7 MB | 2.9 MB | 51 | analyzed |
| `@sentry/mcp-server` | 2.3 MB | 11 MB | 160 | analyzed |
| `agentic-flow` | 3.4 MB | 13.7 MB | 1,669 | **run cut short** |

So a free plan analyzes ordinary MCP servers without trouble, and stops somewhere
above 11 MB unpacked. Entry count tracks the limit better than size does: the
package that failed is barely larger than the one before it but has ten times the
files.

An earlier version of this section claimed a free plan could not analyze anything,
on the grounds that a Workers Free invocation gets 10 ms of CPU while the smallest
package needed 7–8 ms. That was wrong. The mistake was measuring **wall-clock time
in `wrangler dev` and comparing it against a CPU-time limit** — different
quantities, and dev-mode wall time includes work production does not bill. The
figures were real; the conclusion drawn from them was never tested against a
deployed free-tier Worker until it was, and it did not survive.

A package too big for the plan is recorded as a `queued` check saying the run did
not finish, and **the version watermark does not advance**, so it is retried rather
than counted as unchanged. To cover those packages on a free plan, set
`ANALYZE_IN_WORKER = "false"` and let the [free analyzer](.sentinel-watch) or a
[paired runner](packages/watch) do the work — neither is constrained this way.

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

Maintained by its authors. **Code contributions are not accepted**: a tool that
audits supply chains should not have an unvetted one, and the parts most worth
attacking here — the rule pack, the severity policy, the archive reader — are
exactly the parts a drive-by change would touch.

Reports are welcome, and are the most useful thing you can send: a package where
extraction failed, a false positive, a change class that went unreported. Those
improve the published coverage figure and [LIMITATIONS.md](docs/LIMITATIONS.md),
which is where this project's credibility actually sits. See
[SECURITY.md](SECURITY.md) for how to reach us, privately for anything
exploitable.

If you want help wiring this into your stack, or a review of what your MCP surface
actually looks like, that is something we offer as a paid service. The tool itself
stays free and complete.
