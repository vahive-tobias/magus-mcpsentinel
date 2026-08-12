# Coverage corpus

Sentinel recovers a tool inventory by reading source, and that recovery is
incomplete by nature. This directory is how the incompleteness gets measured
rather than estimated.

```sh
npm run build
node scripts/measure-coverage.mjs
```

## What is here

| File | Role |
| --- | --- |
| `packages.txt` | The pinned corpus. Exact `name@version`, never a range. |
| `artifacts.lock.json` | The digest each pinned version resolved to. Verified on every run. |
| `metrics.json` | The measurement. Committed, so a regression shows up in a diff. |
| `accepted-drift.json` | Append-only record of re-baselinings. Absent until one happens. |

Artifacts themselves are cached under `.cache/` and are **not** committed, so
this repository does not redistribute other people's packages.

Be precise about what the lock buys. It detects drift and gives repeatability
**for as long as npm still serves the artifact**: if a pinned version comes back
with different bytes the run fails, which is a finding in its own right and the
exact event this project exists to notice. It is not the guarantee a retained
tarball gives. A withdrawn or unpublished package cannot be re-measured from a
digest, and that risk is accepted here rather than solved.

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

It is not a representative sample of the MCP ecosystem. These thirteen packages
are the ones Hosted Watch monitors, selected for release cadence so that a
monitoring trial would actually produce notices. They over-represent actively
released packages and say nothing about the long tail.

It also does not reproduce the earlier n=25 corpus behind the published 32%
figure. That list was never checked in and cannot be reconstructed, so the two
numbers measure different populations and must not be compared.
