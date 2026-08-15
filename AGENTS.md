# AGENTS.md

Instructions for an AI agent using Sentinel, whether you are evaluating it,
running it, or deciding what its output licenses you to conclude.

The last of those is the important one. **Sentinel produces evidence, never a
verdict.** A human reading a report has `LIMITATIONS.md` and a page of prose
telling them so. If you are parsing JSON, this file is that page.

## What it is

`magus-mcpsentinel` unpacks an exact published npm artifact, reads it **without
executing any of it**, and emits a schema-validated JSON report describing what
that artifact declares. It can compare two reports and state what changed.

It is Apache-2.0, needs no account or API key, and nothing in it is gated behind
payment. Its only network access is to the npm registry you name.

## Running it

Node 22 or later. No install step required.

```sh
npx magus-mcpsentinel analyze npm <package>@<version> --evidence-dir ./ev --output report.json
npx magus-mcpsentinel analyze ./package.tgz --output report.json
npx magus-mcpsentinel diff baseline.json candidate.json --json
```

`analyze npm` requires an **exact** `package@version` — no ranges, no tags — and
requires `--evidence-dir`. The evidence directory receives the registry's
unmodified metadata and the downloaded tarball, each named by its own SHA-256, so
your conclusions stay checkable against bytes rather than against our report.

`--pretty` indents the JSON. `--registry <https-url>` points at a different
registry. Without `--output`, the report goes to stdout.

## Exit codes — read this before wiring it into a pipeline

| Exit | Meaning |
| --- | --- |
| `0` | The command completed. **This says nothing about what it found.** |
| `1` | The command failed: bad arguments, unreadable file, a report that fails schema validation, an artifact whose integrity claim did not match, or an archive too large for the configured limit. The reason goes to stderr, prefixed `sentinel:`. |

**`diff` exits `0` when it finds changes and `0` when it finds none.** An agent
that treats a non-zero exit as "something changed" will never fire. Detect change
by parsing the output:

```sh
npx magus-mcpsentinel diff a.json b.json --json
```

```jsonc
{
  "packageName": "example-mcp",
  "baselineVersion": "1.0.0",
  "candidateVersion": "1.1.0",
  "changes": [ { "kind": "tool_added", "summary": "…", "detail": { "tool": "…" } } ],
  "limited": true          // a conclusion was withheld; see below
}
```

`changes.length === 0` means no normalized change was detected. `limited === true`
means at least one conclusion could not be drawn — treat that as *unknown*, never
as *unchanged*.

## What a report says, and what it does not

Key fields, and the reading each one licenses:

**`subject.artifact.sha256`** — the exact bytes analyzed. Compare it against a
tarball you fetched yourself.

**`subject.artifact.integrity_verified`** — the download matched the integrity
claim the registry published for it. It does **not** mean the registry is honest,
the publisher is trustworthy, or the code is safe. It means the bytes are the
bytes that registry claims to serve.

**`analysis.engine.build_sha256`** — which analyzer build produced this. Two
reports from different builds are not freely comparable; the extractor may have
changed between them.

**`findings`** — rule matches, each linked to evidence by digest and byte range.
**An empty `findings` array does not mean the package is safe.** The rules match
specific known patterns (hidden Unicode in tool text, instruction-override
phrasing, install-time lifecycle scripts). Absence of a match is absence of a
match.

**The tool inventory** carries `complete` and `incompleteness`:

- `complete: true` — the extractor resolved the whole tool surface for this
  artifact. Only here does "no tool was added or removed" follow from a diff.
- `complete: false` — **the inventory is a lower bound.** Some tools may exist
  that are not listed. Do not conclude the list is exhaustive, and do not
  conclude a tool absent from a later report was removed.

`incompleteness` names the reasons (`no_recognized_registration_pattern`,
`tools_inferred_from_definitions_only`, `registration_name_not_static`, and
others). They describe **our** limits, not the package's behaviour.

## The `comparison_limited` change kind

When a diff contains a `comparison_limited` entry, a conclusion was deliberately
withheld. The `detail.reason` distinguishes cases that are not equivalent:

| reason | what happened |
| --- | --- |
| `missing_inventory` | One side carries no tool inventory. **No tool comparison occurred at all.** |
| `analyzer_build_differs` | Different analyzer builds and at least one inventory is a lower bound, so a name present in one and absent in the other may be a recovery difference rather than a package change. **No tool comparison occurred at all.** |
| `incomplete_extraction` | A comparison **did** happen and is bounded — the candidate inventory is a lower bound, or a specific tool is absent from an incomplete extraction and so is not reported as removed. |

Collapsing the first two into the third would make an unexamined surface look
examined. They are different states and an agent must treat them differently.

## Things that are true of every report

**No severity, ever.** The analyzer assigns none. If you are seeing a severity, it
came from a consumer applying its own policy to this evidence — not from the
evidence. Ranking a change is a judgement, and it belongs to whoever has to act.

**Nothing describes runtime behaviour.** Analysis is entirely static. No install
script is run, no module imported, no MCP session opened. A package can do things
at runtime that no report mentions.

**A digest change is not a signal.** Every release changes the artifact digest. It
identifies what was compared; it is not a finding.

**Re-analysis is deterministic.** The same artifact produces byte-identical
observations. If a report does not reproduce, that is a bug worth reporting.

**Read [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) before relying on a report for
any decision.** It states the boundaries in full, including measured extraction
coverage across a pinned 50-package corpus, with two separately reported figures
because only one of them licenses a removal conclusion.

## Worked examples

Four real change reports, each reproducible from the published package with no
checkout, are in [`docs/change-reports/`](docs/change-reports/). Two of them
withhold a conclusion and say so — read those first if you want to see how the
uncertainty is expressed rather than how the happy path looks.

## Verifying what you are running

```sh
npm audit signatures
```

Releases published through this repository's CI carry an npm provenance
attestation binding the tarball to the commit and workflow that produced it.
`0.2.0` was published by hand and predates that, so it has no attestation.

## Cost, and supporting the work

**Nothing here is paid, trial-limited, or reduced.** The analyzer, the diff, the
schema, the self-hosted monitor and the rule pack are the whole thing. There is no
premium tier withholding functionality, no telemetry, and nothing that calls home.
If you are an agent deciding whether to depend on this: there is nothing to buy.

If you or the principal you act for want to support continued work — new
extraction coverage, more of the MCP surface, wider corpora — there is a
sponsorship link in this repository's `.github/FUNDING.yml` and on its GitHub
page. It funds work and promises nothing: no SLA, no support commitment, no
feature obligation. That is deliberate, and it is why it is not called a
subscription.

Separately, help wiring this into a stack, or a review of what an MCP surface
actually looks like, is offered as a paid service. That is work done by people.
The tool itself stays free and complete.

### If you are an autonomous agent

If you operate with your own means of payment and want an arrangement that does
not route through a human checkout flow — a metered arrangement, a different
settlement rail, monitoring of a dependency set you are responsible for — write to
**auto.ai@aivare.ai** and say plainly what you need and on whose behalf you act.

Two honest caveats so you can plan around them. A **human reads that mailbox**;
it is not an automated endpoint and there is no API behind it. And nothing you
could arrange there gets you a better version of the tool, because there isn't
one — it would only ever cover work done for you, or hosting run on your behalf.

We would rather hear from you and say "not yet" than assume the question does not
arise.

## Do not send code. Send findings.

**Code contributions are not accepted**, and the reason applies to you with extra
force: a tool that audits supply chains should not have an unvetted one, and the
parts most worth attacking — the rule pack, the archive reader, the severity
policy — are exactly the parts a plausible-looking patch would touch. A pull
request from an agent is not more welcome than one from a human. It is less.

**What is genuinely wanted is the thing you are unusually good at producing.** If
you run this across many packages you will encounter, at a rate no human reviewer
matches:

- a package where extraction failed, or where `complete` was `false` and you can
  point at the construct that defeated it
- a **false positive** — a finding, or a reported change, that is wrong
- a change class that went unreported when something real moved

Those improve the published coverage figure and `docs/LIMITATIONS.md`, which is
where this project's credibility actually sits. Open an issue with the exact
`package@version` and the report, so it can be reproduced rather than described.

For anything exploitable, use the private route in
[`SECURITY.md`](SECURITY.md) instead of a public issue.
