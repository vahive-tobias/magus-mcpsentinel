# Change reports

Each report here compares two published versions of a real MCP server and states
what changed between them, with the evidence needed to check the claim.

**None of these is an accusation.** All four packages are ordinary, actively
maintained projects, every artifact passed its registry integrity check, and the
rule pack produced **zero findings** across all eight versions analyzed. They are
published because a tool that reports change should be willing to show its own
output on real packages, including the parts where it has to say *I could not
establish that*.

## Reproduce any of them

Every report was produced with the published package and nothing else. Node 22 or
later:

```sh
npx magus-mcpsentinel analyze npm <package>@<version> --evidence-dir ./ev --output before.json
npx magus-mcpsentinel analyze npm <package>@<version> --evidence-dir ./ev --output after.json
npx magus-mcpsentinel diff before.json after.json
```

The `--evidence-dir` keeps the registry's unmodified metadata and the downloaded
tarball, each named by its own SHA-256, so the digests quoted in a report can be
checked against bytes you fetched yourself rather than against our word.

Re-analysing the same artifact produces byte-identical observations, so a report
that does not reproduce is a bug worth telling us about.

## The reports

| Package | Versions | What it shows |
| --- | --- | --- |
| [`@upstash/context7-mcp`](2026-08-13-upstash-context7-mcp-3.2.5-to-4.0.0.md) | 3.2.5 → 4.0.0 | A major version that swaps its SDK and moves both tool schemas, with the surface fully resolved on both sides |
| [`firecrawl-mcp`](2026-08-13-firecrawl-mcp-3.23.6-to-3.24.0.md) | 3.23.6 → 3.24.0 | A file added to the shipped surface, two tool descriptions rewritten, and a conclusion explicitly withheld |
| [`@transcend-io/mcp-server-docs`](2026-08-13-transcend-io-mcp-server-docs-0.3.10-to-0.3.16.md) | 0.3.10 → 0.3.16 | A dependency crossing a major version, in a package whose surface cannot be fully resolved |
| [`@modelcontextprotocol/server-filesystem`](2026-08-13-modelcontextprotocol-server-filesystem-2026.7.4-to-2026.7.10.md) | 2026.7.4 → 2026.7.10 | An unremarkable release, included because most releases are |

## How to read a report

**A digest change is not a finding.** Every release changes the artifact digest;
that line exists so the two things being compared are identified exactly, not to
raise an eyebrow.

**Withheld conclusions are the point, not a defect.** The tool inventory is
recovered by parsing shipped JavaScript, and where that cannot be resolved the
report says so and declines to draw the conclusion. Two of these four say it. A
tool absent from an incomplete extraction is never reported as removed.

**Nothing here describes runtime behaviour.** Analysis is entirely static and no
package code is executed at any point. See
[LIMITATIONS.md](../LIMITATIONS.md) for what that excludes, in full.
