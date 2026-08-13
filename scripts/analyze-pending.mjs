#!/usr/bin/env node
// The compute half of the hybrid pipeline.
//
// The Cloudflare monitor stays the control plane: it holds the watch list, runs
// the schedule, stores reports and raises notices. This asks it what it detected
// but has not analyzed, does that work wherever it happens to be running, and
// posts the reports back. Analysis is the expensive part, and here it is free and
// unconstrained by a Worker's memory ceiling.
//
// It learns nothing about the monitor beyond two endpoints, and the monitor
// learns nothing about it. Either half can be replaced without touching the other.
import { createHmac } from "node:crypto";
import { analyzeNpmPackage, isArchiveTooLarge } from "magus-mcpsentinel/analyze";

const watchUrl = requiredEnv("WATCH_URL").replace(/\/$/, "");
const pollKey = requiredEnv("ANALYZER_POLL_KEY");
const ingestSecret = requiredEnv("ANALYZER_INGEST_SECRET");

// Bounds one run. Outstanding work is not lost: it stays pending in the monitor,
// because a report it never received cannot have advanced anything.
const MAX_PER_RUN = Number(process.env.MAX_PER_RUN ?? "25");

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function fetchPending() {
  const response = await fetch(`${watchUrl}/api/pending`, {
    headers: { authorization: `Bearer ${pollKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(30_000)
  });
  if (response.status === 404) {
    throw new Error("The monitor does not serve /api/pending. Set ANALYZER_POLL_KEY on the Worker to enable the hybrid pipeline.");
  }
  if (!response.ok) throw new Error(`GET /api/pending returned ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.pending)) throw new Error("/api/pending did not return a pending array.");
  return body.pending;
}

async function submitReport(targetId, report) {
  const body = JSON.stringify({ targetId, report });
  // Signed over the exact bytes sent, which is what the monitor verifies.
  const signature = createHmac("sha256", ingestSecret).update(body).digest("hex");
  const response = await fetch(`${watchUrl}/api/reports`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-magus-signature": signature },
    body,
    signal: AbortSignal.timeout(60_000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST /api/reports returned ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function main() {
  const pending = await fetchPending();
  if (pending.length === 0) {
    console.log("Nothing pending.");
    return;
  }
  console.log(`${pending.length} release(s) pending analysis.`);

  let analyzed = 0;
  let failed = 0;

  for (const item of pending.slice(0, MAX_PER_RUN)) {
    const label = `${item.packageName}@${item.version}`;
    try {
      // No decompressed-size ceiling: this is not running in a Worker, so the
      // packages the monitor had to refuse are analyzable here.
      const { report } = await analyzeNpmPackage({ packageName: item.packageName, version: item.version });
      const outcome = await submitReport(item.targetId, report);
      analyzed += 1;
      console.log(`  ${String(outcome.status).padEnd(18)} ${label}`);
    } catch (error) {
      failed += 1;
      const reason = isArchiveTooLarge(error) ? `artifact too large even here: ${error.message}` : messageOf(error);
      // Left pending rather than marked done. The monitor's watermark has not
      // moved, so the next run tries again instead of losing the release.
      console.error(`  ${"failed".padEnd(18)} ${label}: ${reason}`);
    }
  }

  if (pending.length > MAX_PER_RUN) {
    console.log(`${pending.length - MAX_PER_RUN} left for the next run.`);
  }
  console.log(`\n${analyzed} analyzed, ${failed} failed.`);
  if (analyzed === 0 && failed > 0) process.exitCode = 1;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

await main();
