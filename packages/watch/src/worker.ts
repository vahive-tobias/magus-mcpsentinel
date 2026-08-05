import { hmacHex, sha256Hex, verifyApiKey, verifyHmacSignature } from "./auth.js";
import { assertSentinelReport } from "mcp-sentinel/report-contract";
import { createChangeNotice } from "./policy.js";
import { WatchRepository } from "./repository.js";
import type { Env, JsonObject, SentinelReport, WatchTargetRecord } from "./types.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

/**
 * Body size ceilings. The report endpoint is reachable before any signature has
 * been verified, so its limit bounds what an unauthenticated caller can make the
 * Worker buffer. Operator endpoints are authenticated but bounded anyway.
 */
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_OPERATOR_BYTES = 64 * 1024;

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
  const targetId = requiredString(input, "targetId");
  const report = input.report;
  assertSentinelReport(report);
  const target = await requiredTarget(repository, targetId);
  if (report.subject.artifact.package !== target.package_name) {
    return json({ error: "report package does not match the target" }, 409);
  }
  const reportJson = JSON.stringify(report);
  const stored = await repository.insertReport({
    target_id: targetId,
    artifact_sha256: report.subject.artifact.sha256,
    package_version: report.subject.artifact.version,
    report_sha256: await sha256Hex(reportJson),
    report_json: reportJson,
    generated_at: report.generated_at
  });
  if (stored.alreadyKnown) return json({ reportId: stored.report.id, status: "already_known" });
  if (!target.baseline_report_id) {
    await repository.setBaseline(target.id, stored.report.id);
    return json({ reportId: stored.report.id, status: "baseline_recorded" }, 201);
  }
  const baseline = await repository.reportById(target.baseline_report_id);
  if (!baseline) throw new Error("Watch target references a missing baseline report.");
  const notice = createChangeNotice(parseStoredReport(baseline), report);
  const created = await repository.createNotice(target.id, baseline.id, stored.report.id, notice);
  return json({ reportId: stored.report.id, notice: created, status: "review_required" }, 201);
}

async function decideNotice(request: Request, repository: WatchRepository, noticeId: string | undefined): Promise<Response> {
  if (!noticeId) return json({ error: "notice identifier missing" }, 400);
  const body = await readJson(request);
  const state = requiredString(body, "state");
  if (state !== "accepted" && state !== "frozen" && state !== "ignored") return json({ error: "invalid decision state" }, 400);
  const notice = await repository.decideNotice(noticeId, state);
  return notice ? json({ notice }) : json({ error: "notice not found" }, 404);
}

async function checkForNewReleases(env: Env): Promise<void> {
  const repository = new WatchRepository(env.DB);
  for (const target of await repository.listEnabledTargets()) {
    try {
      const metadata = await fetchNpmLatest(target.package_name);
      if (metadata.version === target.last_seen_version) {
        await repository.recordCheck(target.id, "skipped", metadata.version, "No version change.");
        continue;
      }
      if (!env.ANALYZER_URL) {
        await repository.recordCheck(target.id, "skipped", metadata.version, "Analyzer URL is not configured.");
        continue;
      }
      const payload = JSON.stringify({ targetId: target.id, packageName: target.package_name, version: metadata.version });
      const signature = await hmacHex(payload, env.JOB_SIGNING_SECRET);
      const response = await fetch(env.ANALYZER_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-magus-job-signature": signature },
        body: payload
      });
      await repository.recordCheck(target.id, response.ok ? "submitted" : "failed", metadata.version, response.ok ? "Submitted to analyzer." : `Analyzer returned ${response.status}.`);
    } catch (error) {
      await repository.recordCheck(target.id, "failed", undefined, messageOf(error));
    }
  }
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
