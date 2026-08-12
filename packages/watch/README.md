# Sentinel Watch

**Self-hosted release monitoring for public npm MCP servers.**

Watch records a baseline Sentinel report for a package you choose, checks for new
releases on a schedule, and raises a reviewable change notice when something you
previously approved has moved.

**You deploy it. You hold the data.** It is single-tenant by design — there is no
hosted service, no accounts to create with anyone else, and no operator in the
middle. Nothing leaves your infrastructure except requests to the public npm
registry.

It does not call a server safe, execute package code, inspect private packages, or
accept credentials.

## Flow

```text
public npm version change
        |
        v
scheduled Worker detects the new version
        |
        v
the analyzer runs in the Worker (static analysis only, never executes the package)
        |
        v
Sentinel report
        |
        +-- first report: recorded as the baseline
        +-- later report: normalized diff + pending review notice
        |
        v
you accept, freeze, or ignore the candidate
```

An accepted candidate becomes the next baseline. A frozen candidate stays visible
but does not silently advance the baseline.

## How it relates to the analyzer

Watch consumes [`mcp-sentinel`](../sentinel) through its published contract:

```ts
import { analyzeNpmPackage } from "mcp-sentinel/analyze";
import { diffReports } from "mcp-sentinel/diff";
```

The analyzer decides **what changed**. Watch decides **how much it matters** — that
mapping lives in [`src/policy.ts`](src/policy.ts) and is the file to edit if you
disagree with the rankings. Editing it changes how alerts are prioritized; it
cannot change what is detected.

The dependency runs one way. The analyzer has no knowledge of Watch.

## What is implemented

- Cloudflare Worker API and a private operator dashboard.
- D1 schema for watch targets, evidence reports, notices, decisions, check runs.
- HMAC-authenticated report ingestion with a bounded request body.
- Package identity and report-shape validation.
- A Cron handler that checks npm `latest`, deduplicates unchanged versions, and
  analyzes new releases in the Worker itself.
- Baseline, accept, freeze and ignore states.
- Email delivery of the change notice, with a per-notice delivery state and
  retries on every scheduled check. An undelivered notice is a failure state,
  never a clean result.
- A signed per-notice link in that email, so the recipient can read the notice
  and accept the new version as their baseline without an operator key.

## Not implemented

- Webhook and GitHub Issue delivery. Email works; no other channel exists.
- An R2 evidence store and retention jobs.

Multi-tenancy, customer accounts and billing are **not planned**. This is a
single-tenant tool; if you need it for a team, run one instance.

## Local setup

From the repository root:

```sh
npm install
npm run build
npm test --workspace @sentinel/watch
```

Then, in this directory:

```sh
cp .dev.vars.example .dev.vars   # fill in your own secrets
wrangler d1 execute magus-mcp-watch --local --file=./schema.sql
npm run dev
```

**Local development needs no Cloudflare account and no real database.** `--local`
runs against a SQLite file that wrangler manages, and the committed
`wrangler.toml` placeholder is never dereferenced. Do not run `d1 create` or edit
`wrangler.toml` to get started — that is deployment, it is covered below, and
putting a real `database_id` in the committed file fails CI.

Create an account and a watch target for local testing:

```sql
INSERT INTO accounts (id, email, plan, created_at)
VALUES ('11111111-1111-4111-8111-111111111111', 'operator@example.test', 'builder', '2026-08-09T00:00:00.000Z');
```

Trigger the scheduled check without waiting for the cron:

```sh
curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"
```

On Windows PowerShell, a bare `wrangler` resolves to a `.ps1` shim that the
default execution policy blocks. Use `.\node_modules\.bin\wrangler.cmd` instead.

The dashboard asks for the `OPERATOR_API_KEY` from `.dev.vars`; it is held only in
the page's memory for the browser session.

## Which Cloudflare plan you need

**Workers Free analyzes ordinary MCP servers.** Measured on a real free-plan
deployment against the live registry, not inferred:

| package | compressed | unpacked | entries | result |
| --- | ---: | ---: | ---: | --- |
| `@modelcontextprotocol/server-filesystem` | 18 KB | 69 KB | 7 | analyzed |
| `@upstash/context7-mcp` | 28 KB | 95 KB | 12 | analyzed |
| `@salesforce/mcp` | 186 KB | 0.8 MB | 36 | analyzed |
| `@notionhq/notion-mcp-server` | 1.7 MB | 2.9 MB | 51 | analyzed |
| `@sentry/mcp-server` | 2.3 MB | 11 MB | 160 | analyzed |
| `agentic-flow` | 3.4 MB | 13.7 MB | 1,669 | **run cut short** |

The ceiling sits somewhere above 11 MB unpacked. File count predicts it better
than size: the package that failed is only marginally bigger than the one before
it, but carries ten times the entries.

> **This section previously said the opposite.** It claimed a free plan could not
> analyze anything, because a Workers Free invocation gets 10 ms of CPU and the
> smallest package measured 7-8 ms. The measurements were real but the comparison
> was not: they were **wall-clock times from `wrangler dev`, held against a
> CPU-time limit**. Those are different quantities, and dev-mode wall time counts
> work production does not bill. The claim was never run against a deployed
> free-tier Worker until it was, and it failed immediately.

A paid plan raises the ceiling to this deployment's own 64 MB decompressed limit,
which exists because an isolate has 128 MB of memory. Of 208 real MCP server
packages sampled, 3 exceed that.

### When a package is too big for the plan

The run is cut short mid-analysis. Watch writes its check row *before* analysis
starts precisely so this stays visible: the check is left at `queued` saying the
run did not finish, and **the version watermark does not advance**, so the release
is retried rather than counted as unchanged. Verified on a real free-tier
deployment, not just in tests.

To cover those packages without paying, set `ANALYZE_IN_WORKER = "false"` and let
something else do the analysis — either the free
[GitHub Actions monitor](../../.sentinel-watch) or the paired runner described
below. Neither is constrained by a Worker's limits.

## Where the analyzer runs

On a paid plan, in this Worker. There is no separate analyzer service to deploy and
no `ANALYZER_URL` to configure.

`node:zlib` and `node:crypto` are available under the `nodejs_compat` flag, so the
analyzer reads a published tarball and produces a report inside the isolate. As
everywhere else, it never executes the package.

An isolate has 128 MB of memory, which sets a second limit — one that applies on
either plan. Watch refuses any artifact declaring more than **64 MB decompressed**;
of 208 real MCP server packages sampled, 3 exceed it. A refused artifact is
recorded as a `failed` check naming the version and the limit, and **the version
watermark does not advance**, so the release is retried rather than mistaken for
"unchanged". To cover one of those packages, analyze it with the CLI and post the
report as below.

## The hybrid: this monitor as the control plane, analysis elsewhere

Analysis is the expensive part; everything else the monitor does is cheap. So the
two halves can be split, which is worth doing at scale even on a paid plan:

```text
Cloudflare Worker                     wherever you like (GitHub Actions is free)
  cron detects a new release  ──▶  GET  /api/pending
  stores reports, raises notices    ◀──  POST /api/reports   (analyzes, signs, submits)
  serves the dashboard
```

Set `ANALYZE_IN_WORKER = "false"` and `ANALYZER_POLL_KEY`, then run
[`scripts/analyze-pending.mjs`](../../scripts/analyze-pending.mjs) anywhere Node
runs — [`.github/workflows/analyze-pending.yml`](../../.github/workflows/analyze-pending.yml)
does it on a schedule for nothing.

What this buys, beyond cost: a runner is not confined to a Worker's 128 MB
isolate, so the packages this monitor has to refuse are analyzed normally.

`GET /api/pending` exists **only when `ANALYZER_POLL_KEY` is set** — otherwise it
returns 404, so a deployment not using this exposes no extra surface. Its
credential is deliberately not `OPERATOR_API_KEY`: an analyzer needs to see what
is outstanding and submit a report, not create targets or accept notices. A
release stops being pending once a report for that exact version is stored, so an
analyzer that dies mid-run simply leaves the work for the next one.

### Posting a report by hand

`/api/reports` remains available for exactly that:

```json
{"targetId":"uuid","report":{}}
```

Set `x-magus-signature` to the lower-case HMAC-SHA-256 hex digest of the exact
request body, keyed with `ANALYZER_INGEST_SECRET`.

**Ingestion accepts report formats `0.1.0` and `0.2.0`**, so baselines recorded by
an older analyzer stay comparable. A `0.1.0` report carries no tool inventory, so a
comparison involving one reports `comparison_limited` rather than treating an
absent inventory as a set of removed tools.

That is deliberately wider than what the analyzer *writes*. `sentinel analyze`
emits `0.2.0` only, and validates its own output against a schema pinned to that
exact version — which is what catches the analyzer shipping a stale format. So
reading is permissive and writing is exact; a stored `0.1.0` report is perfectly
valid input here and would correctly fail the analyzer's generation-time check.

## Deployment

Written after doing it, so it includes the parts that are not obvious.

**1. Authenticate.** Being signed in to Cloudflare in a browser does *not*
authenticate the CLI:

```sh
wrangler login && wrangler whoami
```

On Windows PowerShell, a bare `wrangler` or `npx` resolves to a `.ps1` shim that
the default execution policy blocks. Use `.\node_modules\.bin\wrangler.cmd`
instead — a batch file is not subject to that policy, and there is no need to
weaken a machine security setting to work around it.

**2. Create the database and keep its ID out of git.**

```sh
wrangler d1 create magus-mcp-watch
npm run deploy:init          # copies wrangler.toml -> wrangler.private.toml
```

Put the returned `database_id` in `wrangler.private.toml`, which is gitignored.
The committed `wrangler.toml` keeps its placeholder, and CI fails if that changes.
A `database_id` is an identifier rather than a credential — it grants nobody
access — but it ties a public repository to a private account.

**3. Apply the schema.**

```sh
wrangler d1 execute magus-mcp-watch --remote --file=schema.sql -c wrangler.private.toml
```

`schema.sql` *creates* a database; it does not migrate one. After this first run,
a new column needs an explicit `ALTER TABLE` — re-running the file will fail on
the first index that references it.

**4. Deploy, then set secrets.** Secrets attach to a Worker that already exists,
so deploy first:

```sh
npm run deploy
```

Then set `OPERATOR_API_KEY` and `ANALYZER_INGEST_SECRET` (both long random
values), plus `RESEND_API_KEY`, `NOTIFY_FROM` and `NOTIFY_TO` for email, and
`NOTICE_LINK_SECRET` and `NOTICE_LINK_ORIGIN` for the link in a notice.
`wrangler secret put` prompts interactively; `wrangler secret bulk file.json`
takes them from a JSON file if a prompt is awkward — delete the file afterwards.

Worker secrets are **write-only**: once set they cannot be read back, so keep
your own copy of anything you generated. Allow a few seconds for a new secret to
propagate; a route gated on one can 404 briefly after it is set.

**5. Confirm it runs.** The cron in your config starts the first check. A row in
`check_runs` with status `analyzed` means the whole path works:

```sh
wrangler d1 execute magus-mcp-watch --remote -c wrangler.private.toml \
  --command "SELECT status, observed_version, detail FROM check_runs ORDER BY created_at;"
```

### Email, specifically

The API key comes from **Resend**, not Cloudflare. Cloudflare only hosts the DNS
records that verify the domain, which is what Resend's auto-configuration writes.
`NOTIFY_FROM` must be on that verified domain, but the mailbox itself does not
have to exist — sending does not require it. If you enabled sending only, replies
to a notice will bounce; set a `reply_to` you actually read if that matters.

Note that `wrangler` bundles `src/worker.ts` with esbuild, which strips types
without checking them. **`npm run build` is the only typecheck** — do not deploy
from a machine that skipped it.

### The link in a notice

A notice tells you what changed; the link is how you act on it. Without one the
only way to accept a new baseline is the operator key, which means the same
notice arrives again on every later release.

Set `NOTICE_LINK_SECRET` (long and random) and `NOTICE_LINK_ORIGIN` (the
Worker's own origin, e.g. `https://watch.example.com`). With either unset the
feature is off: no link goes into a notice, and `/notice/…` returns 404 rather
than falling back to serving anything.

The link is a **capability**, not a login. Its token is HMAC-derived from the
notice id, so it grants access to exactly that one notice — not the notice list,
not the watch targets, not another notice. Two consequences worth knowing
before you enable it:

- Rotating `NOTICE_LINK_SECRET` invalidates every link already sent. That is the
  correct blast radius for a credential that lives in other people's inboxes.
- Anyone holding the link can accept that notice. Treat forwarding a notice as
  handing over the decision on that one release.

Opening a link only renders the notice — accepting is a separate POST from the
page, because mail clients and security scanners fetch links on delivery and an
accept behind a GET would fire before a human read it. A notice already decided
through the operator route is shown as it stands and is not overturned by a
later click.

## Why this cannot run up a D1 bill

D1 charges for rows **scanned**, not rows returned, and Cloudflare has no hard
spend cap to stop a runaway query. Unindexed scans and unbounded repeat-writes
are the two documented ways accounts have gone from a few dollars a month to four
figures, so both are designed against here rather than hoped about:

- **Every query against a growing table is index-backed.** `check_runs` is the
  only table that grows without bound — a row per target per check, forever — and
  it carries indexes for each way it is read. Measured before they existed:
  finding each target's latest check scanned 1,825,000 rows per call against two
  years of history on 25 targets. It is a seek now, and 800× faster.
- **A test fails the build on any full scan of a growing table.** `EXPLAIN QUERY
  PLAN` is run against the real schema, so a query added without an index cannot
  merge. Removing an index makes it fail, which was checked.
- **No write is unbounded.** Every `UPDATE` is keyed on a primary key or an
  indexed column, there are no `DELETE` statements, and a test fails the build on
  any write without a `WHERE` clause.
- **Repeated detections do not repeat writes.** A release stays outstanding until
  something analyzes it, and detection runs every few hours; the check is recorded
  once, not once per poll.

Steady state for 25 packages is roughly 100 row-writes and a few hundred row-reads
a day — comfortably inside the free tier's 100,000 writes and 5 million reads per
day, with or without a paid plan.

## Safety boundary

- Public npm package identities only.
- No credentials, tokens, private registry URLs, local source files, or MCP
  tool-call payloads.
- Treat packages and reports as hostile input.
- A delivery or analysis failure is a failure state, never a clean result.
- A report is evidence, not certification.

See [SECURITY.md](../../SECURITY.md) and
[docs/LIMITATIONS.md](../../docs/LIMITATIONS.md).
