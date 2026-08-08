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
  analyzes new releases in the Worker itself — on a paid plan; see the plan note.
- Baseline, accept, freeze and ignore states.

## Not implemented

- Email, webhook and GitHub Issue delivery.
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
npx wrangler d1 create sentinel-watch
# copy the returned database_id into wrangler.toml
npx wrangler d1 execute sentinel-watch --local --file=./schema.sql
npm run dev
```

Create an account row for local testing:

```sql
INSERT INTO accounts (id, email, plan, created_at)
VALUES ('11111111-1111-4111-8111-111111111111', 'operator@example.test', 'builder', '2026-08-05T00:00:00.000Z');
```

The dashboard asks for the `OPERATOR_API_KEY` from `.dev.vars`; it is held only in
the page's memory for the browser session.

## Which Cloudflare plan you need

**Watch requires a paid Cloudflare Workers plan (~$5/month) to analyze packages
itself.** That is a real constraint on an otherwise free tool, so here it is in
full rather than in a footnote.

> **If you do not want to pay anything, you do not have to.**
> [`.sentinel-watch`](../../.sentinel-watch) runs the same analyzer and the same
> severity policy on GitHub Actions, free, with baselines committed to a repository
> and review as a pull request. It has no package-size limit, so it covers slightly
> more than this does. Choose that one unless you specifically want an always-on
> HTTP endpoint, a dashboard, or a database you query directly.

| | Workers Free | Workers Paid |
| --- | --- | --- |
| Cron polling, D1, notices, dashboard | Yes | Yes |
| Analysis inside the Worker | **No** | Yes |

The reason is a single limit: **a Workers Free invocation gets 10 ms of CPU**, for
scheduled triggers as well as requests. Analysis costs far more. Measured in
workerd against real published packages, building a report alone — before schema
validation, hashing, or any D1 work — costs:

| package | compressed | cold | warm |
| --- | ---: | ---: | ---: |
| `@upstash/context7-mcp` | 28 KB | 34 ms | 7 ms |
| `@modelcontextprotocol/server-filesystem` | 18 KB | 65 ms | 8 ms |
| `@salesforce/mcp` | 186 KB | 19 ms | 12 ms |
| `@notionhq/notion-mcp-server` | 1.7 MB | 373 ms | 221 ms |

Even the smallest packages sit at or above the whole free-plan budget while warm,
and a scheduled trigger cannot count on a warm isolate. The median package in a
208-package sample costs roughly 203 ms. This is not close.

Everything else Watch does fits the free plan comfortably: cron triggers are
available on it (5 per account), and D1's free tier allows 5 million row reads and
100,000 row writes per day against a watch list of tens of packages.

### Running on the free plan: detect-only mode

Set `ANALYZE_IN_WORKER = "false"`. Watch then polls, detects a new release, and
records it as awaiting analysis without downloading the artifact. You produce the
report yourself and post it to `/api/reports`:

```sh
sentinel analyze npm "@scope/package@1.2.3" --evidence-dir ./evidence --output report.json
```

Run that locally or in CI — both free — then submit it as below. You still get the
diff and the change notice; you supply the analysis step. The version watermark
does not advance until a report arrives, so a detected release stays outstanding
rather than being quietly forgotten.

If you leave analysis enabled on a free plan, the run is killed mid-analysis. Watch
writes its check row *before* analysis starts precisely so that this is visible:
you will find checks left at `queued` whose text names the 10 ms CPU limit. It
fails loudly, not silently.

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

### Posting a report by hand

`/api/reports` remains available for exactly that:

```json
{"targetId":"uuid","report":{}}
```

Set `x-magus-signature` to the lower-case HMAC-SHA-256 hex digest of the exact
request body, keyed with `ANALYZER_INGEST_SECRET`.

Report formats `0.1.0` and `0.2.0` are accepted. A `0.1.0` report carries no tool
inventory, so a comparison involving one reports `comparison_limited` rather than
treating an absent inventory as a set of removed tools.

## Deployment

1. Create D1 and copy its ID into `wrangler.toml`.
2. Apply `schema.sql` remotely with `wrangler d1 execute`.
3. Set `OPERATOR_API_KEY` and `ANALYZER_INGEST_SECRET` with `wrangler secret put`.
   Never put them in `wrangler.toml`.
4. **On the free plan**, set `ANALYZE_IN_WORKER = "false"` (a plain var, not a
   secret) and read the detect-only section above. Skip this on a paid plan.
5. Deploy the Worker. The cron trigger in `wrangler.toml` starts the first check.

Note that `wrangler` bundles `src/worker.ts` with esbuild, which strips types
without checking them. **`npm run build` is the only typecheck** — do not deploy
from a machine that skipped it.

## Safety boundary

- Public npm package identities only.
- No credentials, tokens, private registry URLs, local source files, or MCP
  tool-call payloads.
- Treat packages and reports as hostile input.
- A delivery or analysis failure is a failure state, never a clean result.
- A report is evidence, not certification.

See [SECURITY.md](../../SECURITY.md) and
[docs/LIMITATIONS.md](../../docs/LIMITATIONS.md).
