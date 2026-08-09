import { analyzeNpmPackage, isArchiveTooLarge } from "mcp-sentinel/analyze";
import { deliverNotice, deliveryConfigured } from "./notify.js";
import { sha256Hex, verifyApiKey, verifyHmacSignature } from "./auth.js";
import { assertSentinelReport } from "mcp-sentinel/report-contract";
import { createChangeNotice } from "./policy.js";
import { WatchRepository } from "./repository.js";
import type { ChangeNoticeRecord, Env, JsonObject, SentinelReport, WatchTargetRecord } from "./types.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

/**
 * Ceiling on the decompressed artifact, well inside the 128 MB an isolate gets.
 *
 * Measured against 208 real MCP server packages: artifacts up to 59 MB unpacked
 * analyze comfortably, 99 MB and above exhaust the isolate. Three of the 208 sit
 * above this limit. Refusing them at a stated threshold makes that outcome
 * deterministic and reportable, rather than an out-of-memory failure part-way in.
 */
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

/**
 * Analyses attempted per scheduled run.
 *
 * Only a target whose version actually moved is analyzed, so a steady state costs
 * far less than this. The bound matters on a first run, where every target needs
 * a baseline at once. A target left over is not lost: its watermark has not moved,
 * so the next run picks it up.
 */
const MAX_ANALYSES_PER_RUN = 8;

/**
 * How hard to retry an undelivered notice.
 *
 * A notice nobody received is a failure state, so delivery is retried on every
 * scheduled check rather than attempted once. The cap stops a permanently
 * misconfigured channel retrying forever; the row keeps its last error either
 * way, so a notice never quietly becomes "handled".
 */
const MAX_DELIVERY_ATTEMPTS = 6;
const MAX_DELIVERIES_PER_RUN = 20;

/**
 * Body size ceilings. The report endpoint is reachable before any signature has
 * been verified, so its limit bounds what an unauthenticated caller can make the
 * Worker buffer. Operator endpoints are authenticated but bounded anyway.
 */
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_OPERATOR_BYTES = 64 * 1024;

/**
 * Ceiling on a stored report.
 *
 * D1 caps a single row at 2 MB and `report_json` is one column, so a large enough
 * report fails at INSERT rather than on the way in. Refusing it here reports the
 * real reason. The largest report measured against real packages was 649 KB, from
 * an artifact with 3,522 entries.
 */
const MAX_STORED_REPORT_BYTES = 1_500_000;

/** Raised when a request body exceeds its declared ceiling. */
export class BodyTooLargeError extends Error {
  public constructor(public readonly limit: number) {
    super(`Request body exceeds the ${limit} byte limit.`);
    this.name = "BodyTooLargeError";
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      const repository = new WatchRepository(env.DB);
      if (request.method === "GET" && url.pathname === "/") return htmlResponse();
      if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "magus-mcp-watch" });
      if (url.pathname === "/api/reports" && request.method === "POST") return ingestReport(request, env, repository);
      if (url.pathname === "/api/pending" && request.method === "GET") return listPending(request, env, repository);
      if (!await verifyApiKey(request, env.OPERATOR_API_KEY)) return json({ error: "operator authentication required" }, 401);
      if (url.pathname === "/api/targets" && request.method === "GET") return json({ targets: await repository.listTargets() });
      if (url.pathname === "/api/notices" && request.method === "GET") return json({ notices: await repository.listNotices() });
      if (url.pathname === "/api/targets" && request.method === "POST") return createTarget(request, repository);
      const decisionMatch = url.pathname.match(/^\/api\/notices\/([0-9a-f-]{36})\/decision$/i);
      if (decisionMatch && request.method === "POST") return decideNotice(request, repository, decisionMatch[1]);
      return json({ error: "not found" }, 404);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return json({ error: error.message }, 413);
      console.error(error);
      return json({ error: messageOf(error) }, 400);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(checkForNewReleases(env));
  }
} satisfies ExportedHandler<Env>;

async function createTarget(request: Request, repository: WatchRepository): Promise<Response> {
  const body = await readJson(request);
  const accountId = requiredString(body, "accountId");
  const packageName = requiredPackageName(requiredString(body, "packageName"));
  const packageSpec = optionalString(body, "packageSpec") ?? "latest";
  const target = await repository.createTarget({ accountId, packageName, packageSpec });
  return json({ target }, 201);
}

async function ingestReport(request: Request, env: Env, repository: WatchRepository): Promise<Response> {
  const rawBody = await readBoundedText(request, MAX_REPORT_BYTES);
  if (!await verifyHmacSignature(rawBody, request.headers.get("x-magus-signature"), env.ANALYZER_INGEST_SECRET)) {
    return json({ error: "invalid analyzer signature" }, 401);
  }
  const input = parseJson(rawBody);
  const report = input.report;
  assertSentinelReport(report);
  const target = await requiredTarget(repository, requiredString(input, "targetId"));
  try {
    const outcome = await recordReport(repository, target, report);
    await resolveIfPending(repository, target, report, outcome);
    if (outcome.delivery) await deliver(env, repository, outcome.delivery);
    const { delivery: _delivery, ...body } = outcome;
    return json(body, outcome.status === "already_known" ? 200 : 201);
  } catch (error) {
    if (error instanceof ReportIdentityError) return json({ error: error.message }, 409);
    if (error instanceof ReportTooLargeError) return json({ error: error.message }, 413);
    throw error;
  }
}

/**
 * Work for an external analyzer: releases detected but not yet analyzed.
 *
 * Exists only when `ANALYZER_POLL_KEY` is configured. A deployment that analyzes
 * in the Worker, or that submits reports by hand, never serves this route at all
 * rather than serving an authenticated-but-useless one.
 *
 * It is read-only, and its credential is not the operator key: an analyzer needs
 * to see what is outstanding and post a report, not create targets or accept
 * notices on someone's behalf.
 */
async function listPending(request: Request, env: Env, repository: WatchRepository): Promise<Response> {
  if (!env.ANALYZER_POLL_KEY) return json({ error: "not found" }, 404);
  if (!await verifyApiKey(request, env.ANALYZER_POLL_KEY)) {
    return json({ error: "analyzer authentication required" }, 401);
  }
  return json({ pending: await repository.listPendingAnalyses() });
}

/** Raised when a report describes a different package than the target it is filed against. */
class ReportIdentityError extends Error {}

/** Raised when a report is too large to store, before the storage layer rejects it. */
export class ReportTooLargeError extends Error {}

interface PendingDelivery {
  target: WatchTargetRecord;
  notice: ChangeNoticeRecord;
  baselineVersion: string;
  candidateVersion: string;
}

interface IngestOutcome {
  status: "already_known" | "baseline_recorded" | "review_required";
  reportId: string;
  notice?: ChangeNoticeRecord;
  /** Present when this ingest produced a notice that still needs sending. */
  delivery?: PendingDelivery;
}

/**
 * Store a report against a target, and raise a change notice if it moved.
 *
 * Both the scheduled check and the report endpoint go through here. Analysis
 * happening in this Worker rather than in a separate service does not change what
 * a report means, so it must not reach the database by a different route.
 */
async function recordReport(repository: WatchRepository, target: WatchTargetRecord, report: SentinelReport): Promise<IngestOutcome> {
  if (report.subject.artifact.package !== target.package_name) {
    throw new ReportIdentityError("report package does not match the target");
  }
  const reportJson = JSON.stringify(report);
  if (reportJson.length > MAX_STORED_REPORT_BYTES) {
    throw new ReportTooLargeError(`Report is ${reportJson.length} bytes, above the ${MAX_STORED_REPORT_BYTES} byte storage limit for a single row.`);
  }
  const stored = await repository.insertReport({
    target_id: target.id,
    artifact_sha256: report.subject.artifact.sha256,
    package_version: report.subject.artifact.version,
    report_sha256: await sha256Hex(reportJson),
    report_json: reportJson,
    generated_at: report.generated_at
  });
  if (stored.alreadyKnown) return { status: "already_known", reportId: stored.report.id };
  if (!target.baseline_report_id) {
    await repository.setBaseline(target.id, stored.report.id);
    return { status: "baseline_recorded", reportId: stored.report.id };
  }
  const baseline = await repository.reportById(target.baseline_report_id);
  if (!baseline) throw new Error("Watch target references a missing baseline report.");
  const notice = createChangeNotice(parseStoredReport(baseline), report);
  const created = await repository.createNotice(target.id, baseline.id, stored.report.id, notice);
  return {
    status: "review_required",
    reportId: stored.report.id,
    notice: created,
    delivery: { target, notice: created, baselineVersion: baseline.package_version, candidateVersion: report.subject.artifact.version }
  };
}

/**
 * Send a notice, and record what happened either way.
 *
 * Delivery is attempted only after the notice is stored, so a send failure
 * cannot lose the notice itself — the row survives with its error, and the
 * scheduled check retries it.
 */
async function deliver(env: Env, repository: WatchRepository, pending: PendingDelivery): Promise<void> {
  const outcome = await deliverNotice(env, pending.target, pending.notice, {
    baseline: pending.baselineVersion,
    candidate: pending.candidateVersion
  });
  await repository.recordDelivery(pending.notice.id, outcome.state, outcome.detail);
}

/**
 * Retry notices that have not reached anyone.
 *
 * Runs on every scheduled check. A notice whose delivery never succeeded is not
 * a finished piece of work, and nothing else would ever pick it up.
 */
async function deliverOutstandingNotices(env: Env, repository: WatchRepository): Promise<void> {
  if (!deliveryConfigured(env)) return;
  const outstanding = await repository.listUndeliveredNotices(MAX_DELIVERY_ATTEMPTS, MAX_DELIVERIES_PER_RUN);
  for (const notice of outstanding) {
    const target = await repository.targetById(notice.target_id);
    const baseline = await repository.reportById(notice.baseline_report_id);
    const candidate = await repository.reportById(notice.candidate_report_id);
    if (!target || !baseline || !candidate) {
      await repository.recordDelivery(notice.id, "failed", "The notice references a target or report that no longer exists.");
      continue;
    }
    await deliver(env, repository, {
      target,
      notice,
      baselineVersion: baseline.package_version,
      candidateVersion: candidate.package_version
    });
  }
}

/**
 * A report arriving for a release that was waiting on one closes that check.
 *
 * Whether it came from an external analyzer or from an operator running the CLI
 * makes no difference: the release is no longer outstanding.
 */
async function resolveIfPending(repository: WatchRepository, target: WatchTargetRecord, report: SentinelReport, outcome: IngestOutcome): Promise<void> {
  await repository.resolvePendingCheck(
    target.id,
    report.subject.artifact.version,
    `Report received from an external analyzer (${outcome.status}).`
  );
}

async function decideNotice(request: Request, repository: WatchRepository, noticeId: string | undefined): Promise<Response> {
  if (!noticeId) return json({ error: "notice identifier missing" }, 400);
  const body = await readJson(request);
  const state = requiredString(body, "state");
  if (state !== "accepted" && state !== "frozen" && state !== "ignored") return json({ error: "invalid decision state" }, 400);
  const notice = await repository.decideNotice(noticeId, state);
  return notice ? json({ notice }) : json({ error: "notice not found" }, 404);
}

/**
 * Poll every enabled target and analyze whatever moved.
 *
 * The analyzer runs here, in this isolate. It reads the published artifact and
 * never executes it, exactly as it does from the command line.
 *
 * A target whose analysis does not complete keeps its existing watermark, so the
 * next run retries it. That is deliberate: advancing the watermark on a failure
 * would turn "we could not look" into "nothing changed", which is the one thing a
 * change monitor must never report.
 */
export async function checkForNewReleases(env: Env): Promise<void> {
  const repository = new WatchRepository(env.DB);
  let analysesRemaining = MAX_ANALYSES_PER_RUN;

  for (const target of await repository.listEnabledTargets()) {
    try {
      const metadata = await fetchNpmLatest(target.package_name);
      if (metadata.version === target.last_seen_version) {
        await repository.recordCheck(target.id, "skipped", metadata.version, "No version change.");
        continue;
      }
      // A release stays outstanding until something analyzes it, and detection
      // runs every few hours. Re-recording the same pending state each time would
      // write rows forever and say nothing new.
      if (await repository.hasOpenCheck(target.id, metadata.version)) {
        continue;
      }
      if (!analysisEnabled(env)) {
        await repository.recordCheck(target.id, "queued", metadata.version,
          "Detected. In-Worker analysis is disabled, so this release is awaiting a report posted to /api/reports.");
        continue;
      }
      if (analysesRemaining <= 0) {
        await repository.recordCheck(target.id, "queued", metadata.version, "Deferred to the next run: this run reached its analysis budget.");
        continue;
      }
      analysesRemaining -= 1;
      await analyzeAndRecord(env, repository, target, metadata.version);
    } catch (error) {
      await repository.recordCheck(target.id, "failed", undefined, messageOf(error));
    }
  }

  // Notices that never reached anyone, including ones raised while the provider
  // was unreachable. Nothing else would ever pick these up.
  await deliverOutstandingNotices(env, repository);
}

async function analyzeAndRecord(env: Env, repository: WatchRepository, target: WatchTargetRecord, version: string): Promise<void> {
  // Written before any analysis runs. Exceeding the platform CPU limit kills the
  // run outright, so this is the only record that would survive it — a check left
  // at `queued` with this text is the symptom, and it says so.
  const checkId = await repository.beginCheck(target.id, version,
    `Analyzing ${target.package_name}@${version}. A check still showing this text did not finish: on Workers Free the 10 ms CPU limit stops analysis before it completes.`);

  try {
    const analyzed = await analyzeNpmPackage(
      { packageName: target.package_name, version },
      { maxUncompressedBytes: MAX_UNCOMPRESSED_BYTES }
    );
    const outcome = await recordReport(repository, target, analyzed.report);
    if (outcome.delivery) await deliver(env, repository, outcome.delivery);
    await repository.completeCheck(checkId, "analyzed", describeOutcome(outcome, analyzed.entryCount));
  } catch (error) {
    // An artifact too large for this host is a limit of where the analyzer runs,
    // not an observation about the package.
    await repository.completeCheck(checkId, "failed", explainFailure(error));
  }
}

/**
 * Whether this deployment analyzes releases itself.
 *
 * Analysis costs far more than the 10 ms CPU a Workers Free invocation gets, so a
 * free-plan deployment sets `ANALYZE_IN_WORKER = "false"` and submits reports to
 * `/api/reports` instead. Defaulting to enabled keeps the paid path working with
 * no configuration; a free-plan deployment that leaves it on gets checks stranded
 * at `queued`, which names the cause rather than failing silently.
 */
function analysisEnabled(env: Env): boolean {
  return (env.ANALYZE_IN_WORKER ?? "true").toLowerCase() !== "false";
}

function explainFailure(error: unknown): string {
  if (isArchiveTooLarge(error)) {
    return `Not analyzed: the artifact exceeds this deployment's ${MAX_UNCOMPRESSED_BYTES} byte decompressed limit. ${error.message}`;
  }
  if (error instanceof ReportTooLargeError) {
    return `Not stored: ${error.message}`;
  }
  return messageOf(error);
}

function describeOutcome(outcome: IngestOutcome, entryCount: number): string {
  const scanned = `${entryCount} archive entries`;
  if (outcome.status === "already_known") return `Artifact already on record (${scanned}).`;
  if (outcome.status === "baseline_recorded") return `Baseline recorded (${scanned}).`;
  return `${outcome.notice?.severity ?? "review"} change notice raised (${scanned}).`;
}

async function fetchNpmLatest(packageName: string): Promise<{ version: string }> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName).replace("%40", "@")}/latest`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`npm registry returned ${response.status} for ${packageName}.`);
  const metadata = parseJson(await response.text());
  return { version: requiredString(metadata, "version") };
}

async function requiredTarget(repository: WatchRepository, id: string): Promise<WatchTargetRecord> {
  const target = await repository.targetById(id);
  if (!target) throw new Error("Watch target not found.");
  return target;
}

async function readJson(request: Request): Promise<JsonObject> {
  return parseJson(await readBoundedText(request, MAX_OPERATOR_BYTES));
}

/**
 * Read a request body, refusing to buffer more than `maxBytes`.
 *
 * The declared content-length is checked first so an oversized body is rejected
 * before any of it is read, but it is only a hint: the streamed total is counted
 * as well, because a caller controls the header it sends.
 */
export async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError(maxBytes);

  const body = request.body;
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) throw new BodyTooLargeError(maxBytes);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function parseJson(raw: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error("JSON body must be an object.");
    return parsed;
  } catch (error) {
    throw new Error(`Invalid JSON: ${messageOf(error)}`);
  }
}

function parseStoredReport(report: { report_json: string }): SentinelReport {
  const parsed = parseJson(report.report_json);
  assertSentinelReport(parsed);
  return parsed;
}

function requiredString(value: JsonObject, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim().length === 0) throw new Error(`${key} must be a non-empty string.`);
  return candidate.trim();
}

function optionalString(value: JsonObject, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

function requiredPackageName(value: string): string {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(value)) {
    throw new Error("packageName must be a public npm package name.");
  }
  return value;
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function htmlResponse(): Response {
  return new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAGUS MCP Watch</title><style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui;background:#09110f;color:#e9f5ef}body{max-width:980px;margin:3rem auto;padding:0 1rem}h1{letter-spacing:.08em;color:#7ce3b1}.panel{background:#101b17;border:1px solid #284438;border-radius:12px;padding:1.25rem;margin:1rem 0}input,button,select{padding:.65rem;border-radius:7px;border:1px solid #426a53;background:#0b1511;color:inherit}button{background:#3db778;color:#041109;font-weight:700;cursor:pointer}.muted{color:#abc4b5}pre{white-space:pre-wrap;overflow:auto;background:#07100c;padding:1rem;border-radius:8px}</style></head>
<body><h1>MAGUS MCP WATCH</h1><p class="muted">Evidence-first change monitoring. This operator dashboard is for private MVP use only.</p>
<section class="panel"><label>Operator API key <input id="key" type="password" autocomplete="off"></label><button id="load">Load watch state</button></section>
<section class="panel"><h2>Add public npm watch target</h2><input id="account" placeholder="account UUID"><input id="package" placeholder="@scope/package or package"><button id="create">Create watch</button></section>
<section class="panel"><h2>Watch targets</h2><pre id="targets">Load the private MVP state to begin.</pre></section>
<section class="panel"><h2>Change notices</h2><pre id="notices">No data loaded.</pre></section>
<script>
const key=()=>document.querySelector('#key').value; const headers=()=>({Authorization:'Bearer '+key(),'content-type':'application/json'});
async function get(path){const r=await fetch(path,{headers:headers()});const b=await r.json();if(!r.ok)throw new Error(b.error||r.status);return b}
async function load(){try{document.querySelector('#targets').textContent=JSON.stringify((await get('/api/targets')).targets,null,2);document.querySelector('#notices').textContent=JSON.stringify((await get('/api/notices')).notices,null,2)}catch(e){alert(e.message)}}
document.querySelector('#load').onclick=load;document.querySelector('#create').onclick=async()=>{try{const r=await fetch('/api/targets',{method:'POST',headers:headers(),body:JSON.stringify({accountId:document.querySelector('#account').value,packageName:document.querySelector('#package').value})});const b=await r.json();if(!r.ok)throw new Error(b.error||r.status);await load()}catch(e){alert(e.message)}};
</script></body></html>`;
