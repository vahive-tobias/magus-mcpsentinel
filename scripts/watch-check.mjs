#!/usr/bin/env node
// Sentinel Watch, without any hosting.
//
// Same analyzer and same severity policy as the Cloudflare monitor. What differs
// is where the state lives: the approved baseline for each package is a committed
// JSON file, so git is the report history and a pull request is the review step.
// Accepting a change means merging; ignoring it means closing.
//
// This runs anywhere Node runs — GitHub Actions, a cron job, a laptop. It needs no
// database, no Worker, no account and no paid plan.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeNpmPackage } from "mcp-sentinel/analyze";
import { createChangeNotice } from "../packages/watch/dist/src/policy.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const watchDirectory = join(repositoryRoot, ".sentinel-watch");
const baselineDirectory = join(watchDirectory, "baselines");

/** A package name is not a safe filename. Scoped names keep both halves readable. */
function baselineFile(packageName) {
  return `${packageName.replace(/^@/, "").replace(/[^a-zA-Z0-9._-]+/g, "__")}.json`;
}

async function readWatchlist() {
  let raw;
  try {
    raw = await readFile(join(watchDirectory, "watchlist.json"), "utf8");
  } catch {
    return [];
  }
  const parsed = JSON.parse(raw);
  const packages = Array.isArray(parsed) ? parsed : parsed.packages;
  if (!Array.isArray(packages)) throw new Error("watchlist.json must be an array of package names, or an object with a `packages` array.");
  for (const name of packages) {
    if (typeof name !== "string" || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      throw new Error(`Not a public npm package name: ${JSON.stringify(name)}`);
    }
  }
  return packages;
}

async function readBaseline(packageName) {
  try {
    return JSON.parse(await readFile(join(baselineDirectory, baselineFile(packageName)), "utf8"));
  } catch {
    return undefined;
  }
}

async function latestVersion(packageName) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName).replace("%40", "@")}/latest`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`npm registry returned ${response.status} for ${packageName}`);
  const metadata = await response.json();
  if (typeof metadata.version !== "string") throw new Error(`npm registry returned no version for ${packageName}`);
  return metadata.version;
}

async function checkPackage(packageName) {
  const baseline = await readBaseline(packageName);
  const version = await latestVersion(packageName);

  if (baseline && baseline.subject?.artifact?.version === version) {
    return { packageName, version, state: "unchanged" };
  }

  const { report } = await analyzeNpmPackage({ packageName, version });

  if (!baseline) {
    return { packageName, version, state: "baseline_recorded", report };
  }

  const notice = createChangeNotice(baseline, report);
  if (notice.changes.length === 0) {
    // A new version number over an identical declared surface. Worth recording as
    // the new baseline, but it is not something to wake anyone up for.
    return { packageName, version, state: "no_reviewable_change", report, notice };
  }
  return { packageName, version, state: "changed", report, notice, baselineVersion: baseline.subject?.artifact?.version };
}

function renderNotice(result) {
  const lines = [`### ${result.packageName} — ${result.baselineVersion} → ${result.version}`, ""];
  lines.push(`**${result.notice.severity.toUpperCase()}** · ${result.notice.summary}`, "");
  lines.push("| Severity | Change | Detail |", "| --- | --- | --- |");
  for (const change of result.notice.changes) {
    lines.push(`| ${change.severity} | \`${change.kind}\` | ${change.summary.replace(/\|/g, "\\|")} |`);
  }
  return lines.join("\n");
}

const RANK = { info: 0, review: 1, high: 2 };

async function main() {
  const packages = await readWatchlist();
  if (packages.length === 0) {
    console.log("No packages configured. Add names to .sentinel-watch/watchlist.json.");
    return;
  }

  await mkdir(baselineDirectory, { recursive: true });

  const results = [];
  for (const packageName of packages) {
    try {
      const result = await checkPackage(packageName);
      results.push(result);
      console.log(`${result.state.padEnd(20)} ${packageName}@${result.version}`);
    } catch (error) {
      // A package that could not be checked is reported as a failure. It is never
      // silently treated as unchanged, and its baseline is left exactly as it was.
      results.push({ packageName, state: "failed", error: error instanceof Error ? error.message : String(error) });
      console.error(`${"failed".padEnd(20)} ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Only write a baseline once every package has been checked, so a crash midway
  // cannot leave half the watch list advanced.
  for (const result of results) {
    if (result.report) {
      await writeFile(join(baselineDirectory, baselineFile(result.packageName)), `${JSON.stringify(result.report, undefined, 2)}\n`, "utf8");
    }
  }

  const changed = results.filter((result) => result.state === "changed");
  const failed = results.filter((result) => result.state === "failed");
  const recorded = results.filter((result) => result.state === "baseline_recorded");

  const severity = changed.reduce((worst, result) => (RANK[result.notice.severity] > RANK[worst] ? result.notice.severity : worst), "info");
  const title = changed.length > 0
    ? `${severity === "high" ? "HIGH" : "Review"}: ${changed.length} watched package${changed.length === 1 ? "" : "s"} changed`
    : recorded.length > 0 ? `Record baseline for ${recorded.length} package${recorded.length === 1 ? "" : "s"}` : "Sentinel Watch";

  const body = [];
  if (changed.length > 0) {
    body.push("A package you approved has moved. The evidence below is the diff between your committed baseline and the current release.", "");
    body.push(...changed.map(renderNotice));
    body.push("", "---", "", "**Merging this pull request accepts the new baseline.** Close it to keep the existing one.");
  }
  if (recorded.length > 0) {
    body.push("", `### Baselines recorded`, "", ...recorded.map((r) => `- \`${r.packageName}@${r.version}\` — first analysis, nothing to compare against yet.`));
  }
  if (failed.length > 0) {
    body.push("", "### Not checked", "", "These were not analyzed, so their baselines are unchanged and they will be retried.", "");
    body.push(...failed.map((r) => `- \`${r.packageName}\` — ${r.error}`));
  }

  await writeFile(join(watchDirectory, "notice.md"), `${body.join("\n")}\n`, "utf8");

  const hasWork = changed.length > 0 || recorded.length > 0;
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, [
      `has_changes=${hasWork}`,
      `title=${title}`,
      `severity=${severity}`,
      `failed=${failed.length}`
    ].join("\n") + "\n", { flag: "a" });
  }

  console.log(`\n${changed.length} changed, ${recorded.length} baseline(s) recorded, ${failed.length} failed.`);
  // A failure is visible in the run log and in the notice, but it must not mask a
  // change that was found, so the exit code only reflects an inability to check.
  if (failed.length > 0 && changed.length === 0 && recorded.length === 0) process.exitCode = 1;
}

await main();
