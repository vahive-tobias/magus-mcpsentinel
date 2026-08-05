# Sentinel Watch

**Self-hosted release monitoring for public npm MCP servers.**

Watch records a baseline Sentinel report for a package you choose, checks for new
releases on a schedule, and raises a reviewable change notice when something you
previously approved has moved.

**You deploy it. You hold the data.** It is single-tenant by design — there is no
hosted service, no accounts to create with anyone else, and no operator in the
middle. Nothing leaves your infrastructure except requests to the public npm
registry and to an analyzer you run.

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
signed job -> your analyzer (static analysis only)
        |
        v
signed Sentinel report -> ingestion endpoint
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
  submits new versions to an authenticated analyzer endpoint.
- Baseline, accept, freeze and ignore states.

## Not implemented

- The analyzer adapter service that receives jobs and returns signed reports.
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

## Analyzer adapter contract

Watch does not run archive analysis. On a detected release it POSTs this signed job
to `ANALYZER_URL`:

```json
{"targetId":"uuid","packageName":"@scope/package","version":"1.2.3"}
```

Your adapter must:

1. Verify `x-magus-job-signature` as HMAC-SHA-256 over the raw JSON job using
   `JOB_SIGNING_SECRET`.
2. Run the Sentinel analyzer against that exact public npm package and version,
   without executing package code and without credentials.
3. POST the result to `/api/reports` as `{"targetId":"uuid","report":{...}}`.
4. Set `x-magus-signature` to the lower-case HMAC-SHA-256 hex digest of the exact
   request body using `ANALYZER_INGEST_SECRET`.

Report formats `0.1.0` and `0.2.0` are accepted. A `0.1.0` report carries no tool
inventory, so a comparison involving one reports `comparison_limited` rather than
treating an absent inventory as a set of removed tools.

## Deployment

1. Create D1 and copy its ID into `wrangler.toml`.
2. Apply `schema.sql` remotely with `wrangler d1 execute`.
3. Set `OPERATOR_API_KEY`, `ANALYZER_INGEST_SECRET` and `JOB_SIGNING_SECRET` with
   `wrangler secret put`. Never put them in `wrangler.toml`.
4. Deploy the Worker.
5. Deploy your authenticated, static-only analyzer adapter and set `ANALYZER_URL`.

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
