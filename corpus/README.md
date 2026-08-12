# Coverage corpus

Sentinel recovers a tool inventory by reading source, and that recovery is
incomplete by nature. This directory is how the incompleteness gets measured
rather than estimated.

```sh
npm run build
node scripts/measure-coverage.mjs            # ~20s, reuses locked artifacts
node scripts/measure-coverage.mjs --refetch  # fetches everything, checks drift
```

## What is here

| File | Role |
| --- | --- |
| `packages.txt` | The pinned corpus. Exact `name@version`, never a range. |
| `artifacts.lock.json` | The digest each pinned version resolved to. Selects the cached artifact by default; re-verified against the registry on `--refetch`. |
| `metrics.json` | The measurement. Committed, so a regression shows up in a diff. |
| `roles.json` | What each package is — `server`, `client`, `unknown` — with the evidence. |
| `accepted-drift.json` | Append-only record of re-baselinings. Absent until one happens. |

Artifacts themselves are cached under `.cache/` and are **not** committed, so
this repository does not redistribute other people's packages.

Be precise about what the lock buys. It detects drift and gives repeatability
**for as long as npm still serves the artifact**: if a pinned version comes back
with different bytes the run fails, which is a finding in its own right and the
exact event this project exists to notice. It is not the guarantee a retained
tarball gives. A withdrawn or unpublished package cannot be re-measured from a
digest, and that risk is accepted here rather than solved.

And drift is only detected by a run that actually fetches. The default reuses the
locked artifact from `.cache/`, which is what makes re-measuring after an
extractor change take about twenty seconds instead of fifty downloads — so a
cached run records `drift_checked: false` rather than implying a check it did not
perform. The weekly CI job passes `--refetch`.

## Two numbers, and they are not the same

`metrics.json` reports both, because they answer different questions:

- **Inventories recovered** — the package yielded at least one tool. This is the
  figure historically published as a coverage percentage.
- **Statically complete extractions** — extraction resolved everything it looked
  at, so nothing was silently skipped.

A package can yield forty-six recovered tools and still not be statically
complete. Only the second condition licenses a claim that a tool was *removed*,
which is why `diff.ts` withholds removal conclusions without it.

Note what "statically complete" does not mean: it is Sentinel's own condition
about its own analysis, not external evidence that the package has no further
tools. A server that builds its tool list at runtime can be statically complete
and still expose tools no report will ever mention.

Both are reported twice: over the whole corpus, and over the classified-server subset. `@crewhaus/mcp-host` is an MCP **client** — its own
description says so — and it has no tools to find, so counting it as a miss
understates the extractor while counting it as a hit would overstate it. The
classification and its evidence live in `roles.json`, because an exclusion
applied in prose is one nobody can check and one that quietly stops being applied.

## Two scopes, and they are not the same

The corpus made a distinction real that had been implicit:

- **Artifact inventory** — every file shipped in the tarball. Recorded in full,
  always. The file inventory and the static API indicators read all of it.
- **Candidate tool-source scope** — the files eligible to declare *this
  package's* tool surface. Narrower, and narrower on an approximation.

They diverge more than expected. One package ships 5,448 files under
`dist/node_modules`, another 2,680 under `node_modules`; 14 of 50 vendor
something. Reading all of it for tool declarations produced 21 tools that were
not the packages' own — 18 of them the MCP SDK's bundled example servers,
recovered as if `@nocobase/plugin-mcp-server` had registered them.

Sentinel does not stop observing that those files exist. It stops letting them
speak for the tool surface, and says so when an entrypoint loads one anyway.

**Say what this is precisely.** Candidate-source exclusion is a conservative
provenance filter: it decides which files may support a claim about *this
package's* declared surface. It is not a claim that the excluded code cannot run,
cannot be loaded, or cannot expose tools — vendored code frequently does all
three. When entrypoint code reaches excluded content, Sentinel withholds
completeness; it never certifies the content irrelevant.

## What is deliberately not measured

**Precision.** Zero observed false positives comes from spot-checking recovered
names by hand, not from ground truth. Until a labelled fixture corpus exists,
`metrics.json` records `precision.measured: false` rather than a number nobody
can defend.

**Recall.** For the same reason: without knowing a package's actual tool list,
"four tools recovered" says nothing about whether it has four or forty.

A run that cannot measure the whole corpus, or that finds a locked digest has
moved, **refuses to update the baseline** and exits non-zero. A partial run has a
smaller denominator, and a smaller denominator moves the percentage; a coverage
figure that shifts because npm had a bad afternoon is worse than none.

Re-baselining against a changed artifact is deliberate:

```sh
node scripts/measure-coverage.mjs --accept-drift
```

That updates the lock and appends the transition to `accepted-drift.json`, which
is written only when a re-baselining actually happens and is never rewritten.
`metrics.json` describes a single run, so anything recorded there is erased by
the next clean one — correct for a measurement, useless as an audit trail.

It relaxes nothing else. A package that could not be analyzed still blocks the
write, because that is a hole in the measurement rather than a judgement about an
artifact.

## What this corpus is not

It is not a representative sample of the MCP ecosystem. Thirteen packages are the
ones Hosted Watch monitors, selected for release cadence so that a monitoring
trial would produce notices. The other thirty-seven were sampled deliberately
across suspected axes — v2 SDK against v1, bundled against unbundled, small
against large — which is stratification, not representativeness. Nothing here
supports a claim about the ecosystem as a whole.

It is also not an adversarial corpus. Packages published as deliberately
malicious test fixtures measure rule behaviour, not static recovery, and mixing
them into this denominator would make the coverage figure answer neither
question. They belong in a separately labelled adversarial regression set — with
the same no-execution rule and the same refusal to redistribute a tarball.

It also does not reproduce the earlier n=25 corpus behind the published 32%
figure. That list was never checked in and cannot be reconstructed, so the two
numbers measure different populations and must not be compared.
