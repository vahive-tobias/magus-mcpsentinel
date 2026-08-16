# Limitations

Sentinel produces evidence about an npm artifact. It does not certify that a
package is safe, and it cannot. This page states plainly what the analyzer does
not do, so a report is never read as more than it is.

Read this before relying on a Sentinel report for any decision.

## The analyzer never runs the package

Analysis is entirely static. Sentinel unpacks an archive and reads it. It does not
execute install scripts, import modules, start an MCP server, or open a protocol
session. Nothing in a report describes observed runtime behaviour.

A package can therefore do things at runtime that no report mentions.

## The tool inventory is inferred, and it is incomplete

Tool surfaces are recovered by parsing shipped JavaScript. This is inference from
source, not an observation of a running server, which is why the inventory carries
`coverage: "inferred"` and `discovery_status` stays `not_run`.

Measured against a pinned corpus of 50 real published MCP servers, **37 yielded a
usable tool inventory and 12 yielded one the extractor could resolve completely**.
Over the 41 classified as servers rather than clients or libraries, that is 32 and
11. The corpus is checked in with exact versions and artifact digests, so the
figure can be re-run rather than taken on trust: see `corpus/`.

Those are two different claims and only the second licenses a conclusion that a
tool was *removed*. A package can yield forty-six recovered tools while the
extractor still could not resolve everything it looked at.

The corpus is stratified — across SDK versions, bundled and unbundled artifacts,
and size — which is not the same as representative. It supports no claim about the
MCP ecosystem as a whole.

An earlier version of this file reported 32% against a 25-package corpus. That
corpus was never checked in and cannot be reproduced, so the figure has been
retired rather than carried forward or compared against.

When any part of the surface cannot be resolved, the report says so:

| Limitation | Meaning |
| --- | --- |
| `no_recognized_registration_pattern` | No registration site of any known shape was found. The tool list is **unknown**, not empty. |
| `registration_name_not_static` | A registration exists but its name is computed. The tool exists and cannot be named. |
| `tools_inferred_from_definitions_only` | Definitions were found in source, but nothing proves the server registers them. |
| `list_tools_array_not_static` | A tool list is built at runtime and cannot be read statically. |
| `typescript_source_not_parsed` | The package ships TypeScript source, which the parser cannot read. |

**An inventory without `complete: true` is a lower bound.** Treating a short list
as a complete one is the most likely way to misuse a report.

## Findings are signals, not verdicts

The rule pack states verifiable facts. It does not decide whether a package is
malicious, and severity is an input to your policy rather than a judgement.

Rule coverage is deliberately narrow — three rules in v0.1. In particular,
instruction-override detection is a **low-confidence lexical match**: it will miss
rephrasings and will occasionally flag benign text.

An empty `findings` array means the current rules matched nothing. It does not mean
the package is clean.

## Archives that cannot be read unambiguously are refused

An archive containing **two entries at the same path** is rejected rather than
analyzed. This is not a limitation of what can be seen; it is a refusal to report
on an artifact whose contents depend on who extracts it.

The reason is a real difference in behaviour, not a theoretical one. Sentinel's
reader resolved a duplicate path first-wins while `tar` and `npm` extract
last-wins, so a tarball carrying a benign `package/package.json` followed by a
second one with an install script would have produced a clean report describing
the first while an install ran the second. Found by an adversarial review on
2026-08-16 and closed the same day.

A duplicate path is itself the signal. No legitimate npm package in the pinned
corpus ships one.

## Not covered at all

- Prompts and resources. Only tools are extracted, though prompt text is a known
  injection vector.
- Dependency vulnerabilities. Sentinel records what a package depends on. It does
  not consult any advisory database.
- Transitive dependencies. Only the analyzed artifact is inspected; what it pulls
  in at install time is not.
- Non-npm ecosystems, private registries, and remote or HTTP-transport servers.
- Anything requiring credentials. Sentinel never accepts them.
- Obfuscation and minification. Heavily transformed code frequently defeats
  extraction; the report will say the extraction was incomplete, but it cannot
  tell you what was hidden.

## What a report is good for

Establishing that a specific artifact, identified by digest, had a specific
declared shape at a specific time — and comparing two such records to show what
changed between them.

That is a narrow claim, and it is the only one the evidence supports.

## Reporting a problem

If a report is wrong — a tool missed that should have been found, a finding raised
on benign text, an archive that fails to parse — that is a defect worth reporting.
See [SECURITY.md](../SECURITY.md) for how to report issues with security
implications.
