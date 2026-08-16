import { analyzeNpmPackage, isArchiveTooLarge } from "magus-mcpsentinel/analyze";
import { deliverNotice, deliveryConfigured } from "./notify.js";
import { sha256Hex, verifyApiKey, verifyHmacSignature, verifyNoticeLinkToken } from "./auth.js";
import { assertSentinelReport } from "magus-mcpsentinel/report-contract";
import { createChangeNotice } from "./policy.js";
import { WatchRepository } from "./repository.js";
import type { ChangeNoticeRecord, Env, JsonObject, SentinelReport, WatchChange, WatchTargetRecord } from "./types.js";

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

/**
 * Ceiling on the registry document read to count skipped releases. Packages with
 * thousands of versions exist; the count is worth having but never worth an
 * unbounded buffer, and going without it costs only a sentence.
 */
const MAX_PACKUMENT_BYTES = 3 * 1024 * 1024;

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
      if (url.pathname === "/api/reports" && request.method === "POST") return await ingestReport(request, env, repository);
      if (url.pathname === "/api/pending" && request.method === "GET") return await listPending(request, env, repository);

      // Capability routes: authenticated by a per-notice token, not the operator
      // key, which is why they sit above the gate and verify for themselves. Each
      // grants access to exactly one notice and nothing else.
      const noticeMatch = url.pathname.match(/^\/notice\/([0-9a-f-]{36})(\/accept)?$/i);
      if (noticeMatch) {
        const [, noticeId, isAccept] = noticeMatch;
        // GET renders and never mutates. Mail clients and security scanners
        // prefetch links, so an accept behind a GET would be triggered by the
        // act of delivering the email.
        if (isAccept && request.method === "POST") return await acceptViaLink(url, env, repository, noticeId!);
        if (!isAccept && request.method === "GET") return await showNotice(url, env, repository, noticeId!);
        return json({ error: "not found" }, 404);
      }
      if (!await verifyApiKey(request, env.OPERATOR_API_KEY)) return json({ error: "operator authentication required" }, 401);
      if (url.pathname === "/api/targets" && request.method === "GET") return json({ targets: await repository.listTargets() });
      if (url.pathname === "/api/notices" && request.method === "GET") return json({ notices: await repository.listNotices() });
      if (url.pathname === "/api/targets" && request.method === "POST") return await createTarget(request, repository);
      // `/api/reports` alone is the ingest route above, matched exactly, so a read
      // of one report cannot fall through to it.
      const reportMatch = url.pathname.match(/^\/api\/reports\/([0-9a-f-]{36})$/i);
      if (reportMatch && request.method === "GET") return await readReport(repository, reportMatch[1]!);
      const decisionMatch = url.pathname.match(/^\/api\/notices\/([0-9a-f-]{36})\/decision$/i);
      if (decisionMatch && request.method === "POST") return await decideNotice(request, repository, decisionMatch[1]);
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

/**
 * One stored report, as stored.
 *
 * A notice records which two reports it compared but not the version strings
 * themselves, so this is what resolves "3.23.6 → 3.23.8" for anything rendering a
 * notice outside the Worker. It returns the row unchanged rather than a summary:
 * the report is the evidence, and a consumer that has to trust our paraphrase of
 * it cannot verify anything.
 *
 * Operator-authenticated, deliberately. A public build can read it with the key
 * held as a build secret and publish the result as static files; that keeps the
 * evidence available without putting a readable route on the internet.
 */
async function readReport(repository: WatchRepository, id: string): Promise<Response> {
  const report = await repository.reportById(id);
  if (!report) return json({ error: "not found" }, 404);
  return json({ report });
}

/**
 * Resolve a capability link to its notice, or explain nothing.
 *
 * A wrong token and a missing notice both return 404 with no detail. Telling an
 * unauthenticated caller that a notice exists but their token is wrong confirms
 * the identifier, and identifiers are the only thing protecting these records.
 */
async function noticeFromLink(
  url: URL,
  env: Env,
  repository: WatchRepository,
  noticeId: string
): Promise<ChangeNoticeRecord | undefined> {
  // No signing secret means the feature is off, not that anything is readable.
  if (!env.NOTICE_LINK_SECRET) return undefined;
  if (!await verifyNoticeLinkToken(noticeId, url.searchParams.get("t"), env.NOTICE_LINK_SECRET)) return undefined;
  return (await repository.noticeById(noticeId)) ?? undefined;
}

async function showNotice(url: URL, env: Env, repository: WatchRepository, noticeId: string): Promise<Response> {
  const notice = await noticeFromLink(url, env, repository, noticeId);
  if (!notice) return json({ error: "not found" }, 404);
  const target = await repository.targetById(notice.target_id);
  const versions = await noticeVersions(repository, notice);
  return new Response(renderNoticePage(notice, target?.package_name ?? "unknown", versions, url, await approvedVersion(repository, target)), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  });
}

/** The version currently approved for this target, whatever any one notice proposed. */
async function approvedVersion(repository: WatchRepository, target: WatchTargetRecord | null): Promise<string | undefined> {
  if (!target?.baseline_report_id) return undefined;
  return (await repository.reportById(target.baseline_report_id))?.package_version;
}

async function acceptViaLink(url: URL, env: Env, repository: WatchRepository, noticeId: string): Promise<Response> {
  const notice = await noticeFromLink(url, env, repository, noticeId);
  if (!notice) return json({ error: "not found" }, 404);

  // Accepting is what rebaselines the target, which is the whole point: without
  // it every later release diffs against a version the reader already approved
  // and the same notice arrives again.
  //
  // A notice that was already decided is left alone. Re-posting is harmless for
  // one already accepted, but a link accept must not overturn a freeze made
  // through the operator route — the newer decision is not the more considered one.
  const decided = notice.state !== "pending_review"
    ? notice
    : (await repository.decideNotice(noticeId, "accepted")) ?? notice;
  // Read back afterwards. Accepting an older notice than the one already accepted
  // records the decision without moving the baseline, and the page must say what
  // is actually approved rather than assume this release became it.
  const target = await repository.targetById(notice.target_id);
  const versions = await noticeVersions(repository, notice);
  return new Response(renderNoticePage(decided, target?.package_name ?? "unknown", versions, url, await approvedVersion(repository, target)), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  });
}

async function noticeVersions(repository: WatchRepository, notice: ChangeNoticeRecord): Promise<{ baseline: string; candidate: string }> {
  const [baseline, candidate] = await Promise.all([
    repository.reportById(notice.baseline_report_id),
    repository.reportById(notice.candidate_report_id)
  ]);
  return { baseline: baseline?.package_version ?? "unknown", candidate: candidate?.package_version ?? "unknown" };
}

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

  // The check runs on a schedule and only sees `latest`, so a diff spanning several
  // releases must not read as "we saw everything in between".
  //
  // This states only what the registry was asked: how many other versions were
  // published between these two. It deliberately does not claim they went
  // unanalyzed — a package that releases twice inside one baseline window can have
  // had the middle release analyzed under its own notice, and this count, taken
  // from the registry rather than from what is stored, cannot tell the difference.
  const between = await releasesBetween(target.package_name, baseline.package_version, report.subject.artifact.version);
  if (between !== undefined && between > 0) {
    notice.summary += ` ${between} other release${between === 1 ? " was" : "s were"} published between these two versions.`;
  }

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
 * A target whose analysis does not complete keeps its existing watermark, because
 * advancing it on a failure would turn "we could not look" into "nothing
 * changed", which is the one thing a change monitor must never report.
 *
 * What happens next depends on how it failed, and the two are not the same. An
 * error the analyzer raises is recorded as `failed`, and the next run retries it.
 * A run killed mid-analysis leaves its check at `queued`, which `hasOpenCheck`
 * below then skips on every later run — deliberately, since an unbounded retry of
 * something that will never fit is the runaway-write pattern. That check is the
 * handoff to `/api/pending`, not work this loop will pick up again.
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
  // States the observation, not a cause. A run can be cut short for more than one
  // reason, and naming the wrong one sends the reader somewhere useless.
  const checkId = await repository.beginCheck(target.id, version,
    `Analyzing ${target.package_name}@${version}. A check still showing this text did not finish — the run was cut short before analysis completed, most often because the artifact was too large for the plan this Worker is on.`);

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

/**
 * How many versions were published between two, and never analyzed.
 *
 * The check runs on a schedule and only ever sees `latest`, so a package that
 * ships several times between runs has releases that are never fetched, never
 * diffed and never stored. That is a real limit, and the notice says so rather
 * than implying every release was examined — some packages publish many times a
 * day, so the gap can be large.
 *
 * Returns undefined when it cannot be established. A count that might be wrong is
 * worse than no count, so nothing is reported unless the registry supplied
 * publish times for both endpoints.
 */
async function releasesBetween(packageName: string, from: string, to: string): Promise<number | undefined> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName).replace("%40", "@")}`, {
      // Deliberately the full document. The abbreviated `install-v1` form is far
      // smaller but omits `time`, which is the only field this needs — asking for
      // it returns a document that always yields no count, silently.
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) return undefined;
    // A package with thousands of versions has a large document, and this is a
    // nicety rather than the check itself. Refuse to buffer an unbounded one.
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_PACKUMENT_BYTES) return undefined;
    const body = await response.text();
    if (body.length > MAX_PACKUMENT_BYTES) return undefined;

    const document = parseJson(body);
    const times = document.time;
    if (!isRecord(times)) return undefined;

    const start = Date.parse(String(times[from] ?? ""));
    const end = Date.parse(String(times[to] ?? ""));
    if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;

    let between = 0;
    for (const [version, published] of Object.entries(times)) {
      if (version === "created" || version === "modified" || version === from || version === to) continue;
      const at = Date.parse(String(published));
      if (Number.isFinite(at) && at > start && at < end) between += 1;
    }
    return between;
  } catch {
    // A count is a nicety. Failing to get one must never fail the check.
    return undefined;
  }
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

/**
 * One notice, for the person it was emailed to.
 *
 * Deliberately plain. This is a transactional page reached from an alert, not a
 * place to browse, and it carries the same posture as the notice itself: it
 * states what changed and never says whether the package is safe.
 */
function renderNoticePage(
  notice: ChangeNoticeRecord,
  packageName: string,
  versions: { baseline: string; candidate: string },
  url: URL,
  approved?: string
): string {
  const changes = parseChanges(notice.changes_json);
  // `accepted` is not the only decided state — a notice can be frozen or ignored
  // through the operator route. Telling the reader it was accepted when it was
  // frozen would misreport which version their next notice compares against.
  const outcome = notice.state === "pending_review" ? undefined : notice.state;
  const rows = changes.map((change) => {
    const named = namedItemsFor(change);
    return `<tr><td class="k">${escapeHtml(change.kind)}</td><td>${escapeHtml(change.summary)}${
      named.length > 0 ? `<ul>${named.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""
    }</td></tr>`;
  }).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(packageName)} — Sentinel change notice</title><style>
:root{--paper:#f3f0e9;--ink:#111723;--body:#4f5967;--muted:#78818d;--line:#d5d0c5;--signal:#c84a20;--soft:#f3dfd6}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--body);font:16px/1.6 Inter,system-ui,sans-serif}
.shell{width:min(100% - 3rem,52rem);margin:3rem auto}
h1{font-family:Georgia,serif;font-weight:500;color:var(--ink);font-size:1.6rem;margin:.4rem 0 1.2rem;font-family:ui-monospace,monospace}
.eyebrow{font:.7rem ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--signal)}
.flow{display:flex;gap:.6rem;align-items:center;font:.8rem ui-monospace,monospace;margin-bottom:1.6rem}
.flow span{border:1px solid var(--line);padding:.5rem .8rem;background:#fff}
table{width:100%;border-collapse:collapse;font-size:.92rem}
td{padding:.7rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
.k{font:.72rem ui-monospace,monospace;color:var(--muted);white-space:nowrap}
ul{margin:.4rem 0 0;padding-left:1rem;font:.78rem ui-monospace,monospace;color:var(--ink)}
form{margin-top:2rem}
button{font:inherit;font-weight:650;background:var(--signal);color:#fff;border:1px solid var(--signal);padding:.7rem 1.2rem;cursor:pointer}
.done{margin-top:2rem;padding:1rem 1.2rem;background:var(--soft);color:var(--ink)}
.note{margin-top:2rem;font-size:.85rem;color:var(--muted)}
</style></head><body><div class="shell">
<span class="eyebrow">Sentinel change notice</span>
<h1>${escapeHtml(packageName)}</h1>
<div class="flow"><span>approved ${escapeHtml(versions.baseline)}</span>&rarr;<span>published ${escapeHtml(versions.candidate)}</span></div>
<table>${rows}</table>
${outcome
  ? `<p class="done">${outcome !== "accepted"
      ? `Already decided: <strong>${escapeHtml(outcome)}</strong>. The approved version is unchanged, so later releases are still compared against ${escapeHtml(versions.baseline)}.</p>`
      : approved === undefined || approved === versions.candidate
        ? `Accepted. <strong>${escapeHtml(versions.candidate)}</strong> is now the approved version, so future notices compare against it rather than ${escapeHtml(versions.baseline)}.</p>`
        // A newer release was accepted first. Recording this decision is right;
        // moving the approved version back to an older release is not.
        : `Accepted. The approved version stays at <strong>${escapeHtml(approved)}</strong>, which is a later release than this one — accepting an older notice records that you read it and does not move the baseline backwards.</p>`}`
  : `<form method="post" action="${escapeHtml(url.pathname)}/accept?t=${escapeHtml(url.searchParams.get("t") ?? "")}">
<button type="submit">Accept this version as the new baseline</button>
</form>
<p class="note">Accepting records that you have read this change. Later releases are then compared against ${escapeHtml(versions.candidate)}, instead of repeating this notice against ${escapeHtml(versions.baseline)} every time.</p>`}
<p class="note">Sentinel does not decide whether a package is safe. It reports what changed between two published artifacts and leaves the judgement to you.</p>
</div></body></html>`;
}

/** The concrete items behind a change's count, matching what the email shows. */
function namedItemsFor(change: WatchChange): string[] {
  const detail = (change.detail ?? {}) as Record<string, unknown>;
  const items: string[] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (!Array.isArray(value)) continue;
    const marker = key === "added" ? "+ " : key === "removed" ? "− " : "~ ";
    for (const entry of value) {
      if (typeof entry === "string" && !change.summary.includes(entry)) items.push(marker + entry);
    }
  }
  return items.slice(0, 25);
}

function parseChanges(json: string): WatchChange[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed as WatchChange[] : [];
  } catch {
    return [];
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ?? character
  ));
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
