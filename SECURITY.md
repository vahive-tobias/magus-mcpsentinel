# Security

## Reporting a vulnerability

Report suspected vulnerabilities privately. Do not open a public issue.

Use GitHub's private vulnerability reporting on this repository, or contact the
maintainer directly. Please include the affected version, a description, and a
reproducer if you have one.

Acknowledgement is on a best-effort basis. This is a small project without a
staffed security response, and it does not offer a bounty or a guaranteed response
time. That is stated here so expectations are accurate rather than implied.

## Threat model

Sentinel's central assumption: **everything inside an analyzed package is hostile
input.** Archives, file paths, source text, package metadata and tool descriptions
are all attacker-controlled. The analyzer is designed so that reading them cannot
compromise the machine doing the reading.

Concretely:

- **Package code is never executed.** No install scripts, no imports, no module
  loading, no server start. Analysis is parsing only.
- **Archive extraction is bounded** in compressed size, decompressed size, entry
  count, and per-file parse size, to resist decompression bombs.
- **Archive paths are validated on every path that produces one.** A tar entry name,
  a GNU long-name override and a pax `path` record all pass through the same
  normalization, which rejects absolute paths, traversal segments, and anything
  outside the package root.
- **Nothing is written outside an explicit output path.** Archive contents are read
  into memory and never unpacked to disk.
- **Unknown archive constructs fail closed.** An unsupported tar entry type aborts
  the analysis. An analyzer that cannot read an archive must error, never return a
  clean result.
- **No credentials are accepted.** Sentinel has no mechanism to receive a registry
  token, and only fetches from public HTTPS registry endpoints without credentials.
- **Downloads are integrity-checked** against the registry's `dist.integrity` claim
  when one is published, and a mismatch is refused.

## The monitor service (`packages/watch`)

The monitor is a self-hosted, single-tenant service. **You deploy it, you hold the
data, and there is no operator in the middle.** It is not a hosted product and it
stores nothing on anyone else's behalf.

Its own boundary:

- **Public npm package identities only.** It has no mechanism to accept a registry
  token, a private registry URL, or local source paths.
- **It never runs an analysis itself.** It dispatches a signed job to an analyzer
  and ingests the resulting report.
- **Both machine-to-machine paths are authenticated.** Jobs are signed with
  `JOB_SIGNING_SECRET`; ingested reports must carry a valid HMAC over the exact
  request body using `ANALYZER_INGEST_SECRET`. An unsigned callback is refused.
- **The ingest endpoint is reachable before any signature is checked**, so the body
  it will buffer is capped (4 MB) on both the declared `content-length` and the
  bytes actually read. Operator endpoints are capped at 64 KB.
- **A failed or delayed check is a failure state**, never rendered as a clean
  result.

If you deploy it, `OPERATOR_API_KEY`, `ANALYZER_INGEST_SECRET` and
`JOB_SIGNING_SECRET` are yours to generate and protect. Set them with
`wrangler secret put`; never place them in `wrangler.toml`.

## What Sentinel does not protect against

A report is evidence about an artifact, not a safety guarantee. Static analysis
cannot observe runtime behaviour, and the tool inventory is incomplete by
construction.

[docs/LIMITATIONS.md](docs/LIMITATIONS.md) states the boundaries in full. **Read it
before treating a report as an assurance of anything.**

## Reports are not sanitized for display

A report contains data derived from a hostile package: tool names, file paths and
finding summaries. Findings reference package text by digest and byte range rather
than reproducing it, but observations do carry attacker-influenced strings.

If you render a report in a web page, terminal or chat client, **escape it.** Treat
report content with the same suspicion as the package it came from.

## Supported versions

Only the latest published version receives fixes. There are no long-term support
branches.
