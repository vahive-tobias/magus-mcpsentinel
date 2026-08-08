#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readNpmArchiveBytes } from "./archive.js";
import { readNpmArchive, preserveAcquisitionEvidence } from "./node-io.js";
import { acquireNpmPackage, parseNpmSpecifier } from "./npm-registry.js";
import { createStaticReport } from "./report.js";
import { validateReport } from "./schema.js";
import { diffReports } from "./diff.js";
import { assertSentinelReport, type SentinelReport } from "./report-contract.js";

async function main(arguments_: string[]): Promise<void> {
  const [command, target, ...options] = arguments_;
  if (command === "diff") {
    await runDiff(target, options);
    return;
  }
  if (command !== "analyze" || !target) {
    throw new Error(usage());
  }
  const parsedOptions = parseOptions(options);
  let report;
  let acquisitionMessage = "";
  if (target === "npm") {
    const specifier = parsedOptions.positionals[0];
    if (!specifier || parsedOptions.positionals.length !== 1 || !parsedOptions.evidenceDirectory) {
      throw new Error(`${usage()}\nThe npm target requires an exact package@version and --evidence-dir.`);
    }
    const acquisition = await acquireNpmPackage(parseNpmSpecifier(specifier), parsedOptions.registry);
    const evidence = await preserveAcquisitionEvidence(acquisition, resolve(parsedOptions.evidenceDirectory));
    report = await createStaticReport(readNpmArchiveBytes(acquisition.tarball), {
      requestedPackage: acquisition.request.packageName,
      requestedVersion: acquisition.request.version,
      acquiredAt: acquisition.acquiredAt,
      metadataUrl: acquisition.metadataUrl,
      metadataSha256: acquisition.metadataSha256,
      tarballUrl: acquisition.tarballUrl,
      integrityClaim: acquisition.integrityClaim,
      integrityVerified: acquisition.integrityVerified
    });
    acquisitionMessage = `\nPreserved raw registry metadata at ${evidence.metadataPath}\nPreserved downloaded artifact at ${evidence.tarballPath}`;
  } else {
    if (parsedOptions.positionals.length !== 0 || parsedOptions.registry || parsedOptions.evidenceDirectory) {
      throw new Error(usage());
    }
    report = await createStaticReport(await readNpmArchive(resolve(target)));
  }
  await validateReport(report);
  const serialized = JSON.stringify(report, null, parsedOptions.pretty ? 2 : undefined);

  if (parsedOptions.outputPath) {
    const resolvedOutput = resolve(parsedOptions.outputPath);
    await mkdir(dirname(resolvedOutput), { recursive: true });
    await writeFile(resolvedOutput, `${serialized}\n`, "utf8");
    process.stdout.write(`Wrote schema-valid Sentinel report to ${resolvedOutput}${acquisitionMessage}\n`);
    return;
  }
  process.stdout.write(`${serialized}\n`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`sentinel: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

interface ParsedOptions {
  outputPath?: string;
  evidenceDirectory?: string;
  registry?: string;
  pretty: boolean;
  json: boolean;
  positionals: string[];
}

function parseOptions(options: string[]): ParsedOptions {
  const parsed: ParsedOptions = { pretty: false, json: false, positionals: [] };
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--pretty") {
      parsed.pretty = true;
      continue;
    }
    if (option === "--json") {
      parsed.json = true;
      continue;
    }
    if (option === "--output" || option === "--evidence-dir" || option === "--registry") {
      const value = options[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${option} requires a value.`);
      }
      if (option === "--output") parsed.outputPath = value;
      if (option === "--evidence-dir") parsed.evidenceDirectory = value;
      if (option === "--registry") parsed.registry = value;
      index += 1;
      continue;
    }
    if (option.startsWith("--")) {
      throw new Error(`Unknown option: ${option}`);
    }
    parsed.positionals.push(option);
  }
  return parsed;
}

/**
 * Compare two evidence reports.
 *
 * Output states what changed. It deliberately assigns no severity: ranking a
 * change is policy, and policy belongs to whoever has to act on it.
 */
async function runDiff(baselinePath: string | undefined, options: string[]): Promise<void> {
  const parsed = parseOptions(options);
  const candidatePath = parsed.positionals[0];
  if (!baselinePath || !candidatePath || parsed.positionals.length !== 1) {
    throw new Error(`${usage()}\nThe diff command requires exactly two report paths.`);
  }

  const baseline = await readReport(baselinePath);
  const candidate = await readReport(candidatePath);
  const result = diffReports(baseline, candidate);

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result, undefined, parsed.pretty ? 2 : undefined)}\n`);
    return;
  }

  const header = `${result.packageName}: ${result.baselineVersion} -> ${result.candidateVersion}`;
  if (result.changes.length === 0) {
    process.stdout.write(`${header}\nNo normalized changes.\n`);
    return;
  }
  const lines = result.changes.map((change) => `  [${change.kind}] ${change.summary}`);
  process.stdout.write(`${header}\n${result.changes.length} change(s):\n${lines.join("\n")}\n`);
  if (result.limited) {
    process.stdout.write("\nSome conclusions were withheld; see the comparison_limited entries above.\n");
  }
}

async function readReport(path: string): Promise<SentinelReport> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    throw new Error(`Unable to read report ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertSentinelReport(parsed);
  return parsed;
}

function usage(): string {
  return [
    "Usage:",
    "  sentinel analyze <package.tgz> [--output <report.json>] [--pretty]",
    "  sentinel analyze npm <package>@<version> --evidence-dir <directory> [--output <report.json>] [--registry <https-url>] [--pretty]",
    "  sentinel diff <baseline.json> <candidate.json> [--json] [--pretty]"
  ].join("\n");
}
