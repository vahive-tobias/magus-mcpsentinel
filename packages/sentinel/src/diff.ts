import {
  assertSentinelReport,
  isRecord,
  isString,
  OBSERVATION_IDS,
  OBSERVATION_KINDS,
  type JsonObject,
  type ReportFinding,
  type ReportObservation,
  type SentinelReport
} from "./report-contract.js";

/**
 * Deterministic comparison of two Sentinel evidence reports.
 *
 * This module reports **what changed**. It does not decide how much any change
 * matters: there is no severity here, and there will not be one. Ranking a
 * change is policy, and policy belongs to the consumer that has to act on it.
 *
 * Dependency-free by design so a constrained runtime can import it.
 */

/** package.json fields whose change alters what actually executes. */
const ENTRYPOINT_FIELDS = ["main", "bin", "exports"];

/** npm runs these on the installing machine, before the server is ever started. */
const INSTALL_SCRIPTS = new Set(["preinstall", "install", "postinstall", "prepare"]);

/** Excluded from metadata comparison: these change on every release by definition. */
const VOLATILE_METADATA = new Set(["name", "version"]);

export type ChangeKind =
  | "artifact_changed"
  | "dependency_added"
  | "dependency_removed"
  | "dependency_changed"
  | "indicator_added"
  | "indicator_removed"
  | "tool_added"
  | "tool_removed"
  | "tool_schema_changed"
  | "tool_description_changed"
  | "entrypoint_changed"
  | "install_script_changed"
  | "script_changed"
  | "server_identity_changed"
  | "metadata_changed"
  | "file_inventory_changed"
  | "file_content_changed"
  | "skill_changed"
  | "plugin_manifest_changed"
  | "mcp_declaration_changed"
  | "comparison_limited"
  | "finding_added"
  | "finding_removed";

export interface ReportChange {
  kind: ChangeKind;
  /** Stable, human-readable statement of fact. Never contains an offset. */
  summary: string;
  /** Machine-readable specifics, so a consumer can rank without parsing prose. */
  detail?: JsonObject;
}

export interface ReportDiff {
  packageName: string;
  baselineVersion: string;
  candidateVersion: string;
  changes: ReportChange[];
  /** True when a conclusion had to be withheld; see `comparison_limited` changes. */
  limited: boolean;
}

export interface ToolRecord {
  name: string;
  description_sha256?: string;
  input_schema_sha256?: string;
  input_schema_properties?: string[];
}

export interface ToolInventory {
  tools: Map<string, ToolRecord>;
  complete: boolean;
}

export interface Snapshot {
  packageName: string;
  version: string;
  artifactSha256: string;
  dependencies: Record<string, string>;
  indicators: Set<string>;
  inventory: ToolInventory | undefined;
  metadata: JsonObject;
  /**
   * Every archive path, mapped to the digest of its contents.
   *
   * Paths alone were kept here originally, which made a file edited in place
   * invisible: the inventory was identical, so only the whole-artifact digest
   * moved and the diff could say "something changed" without saying what. The
   * digests were always in the report; the comparison simply discarded them.
   *
   * A path with no digest is an entry that has no contents — a directory or a
   * link — and is compared by presence only.
   */
  files: Map<string, string | undefined> | undefined;
  findings: Map<string, ReportFinding>;
}

export function snapshotFromReport(report: SentinelReport): Snapshot {
  assertSentinelReport(report);
  const indicators = new Set(
    report.observations
      .filter((item) => item.kind === OBSERVATION_KINDS.codeIndicator)
      .map((item) => (isString(item.data.indicator) ? item.data.indicator : undefined))
      .filter((value): value is string => value !== undefined)
  );
  const findings = new Map<string, ReportFinding>();
  for (const finding of report.findings) {
    if (finding && isString(finding.category) && isString(finding.summary)) {
      findings.set(`${finding.category}:${finding.summary}`, finding);
    }
  }
  return {
    packageName: report.subject.artifact.package,
    version: report.subject.artifact.version,
    artifactSha256: report.subject.artifact.sha256,
    dependencies: dependenciesFrom(report.observations),
    indicators,
    inventory: inventoryFrom(report.observations),
    metadata: metadataFrom(report.observations),
    files: filesFrom(report.observations),
    findings
  };
}

export function diffReports(baselineReport: SentinelReport, candidateReport: SentinelReport): ReportDiff {
  const baseline = snapshotFromReport(baselineReport);
  const candidate = snapshotFromReport(candidateReport);
  if (baseline.packageName !== candidate.packageName) {
    throw new Error("A candidate report cannot be compared to a baseline for a different npm package.");
  }

  const changes: ReportChange[] = [];
  if (baseline.artifactSha256 !== candidate.artifactSha256) {
    changes.push({
      kind: "artifact_changed",
      summary: `Artifact digest changed: ${shortHash(baseline.artifactSha256)} → ${shortHash(candidate.artifactSha256)}.`,
      detail: { before: baseline.artifactSha256, after: candidate.artifactSha256 }
    });
  }
  changes.push(...compareDependencies(baseline.dependencies, candidate.dependencies));
  changes.push(...compareIndicators(baseline.indicators, candidate.indicators));
  changes.push(...compareTools(baseline.inventory, candidate.inventory));
  changes.push(...compareMetadata(baseline.metadata, candidate.metadata));
  changes.push(...compareFiles(baseline.files, candidate.files));
  changes.push(...compareFindings(baseline.findings, candidate.findings));

  return {
    packageName: candidate.packageName,
    baselineVersion: baseline.version,
    candidateVersion: candidate.version,
    changes,
    limited: changes.some((change) => change.kind === "comparison_limited")
  };
}

function compareDependencies(baseline: Record<string, string>, candidate: Record<string, string>): ReportChange[] {
  const changes: ReportChange[] = [];
  for (const name of [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort()) {
    const before = baseline[name];
    const after = candidate[name];
    if (before === undefined && after !== undefined) {
      changes.push({ kind: "dependency_added", summary: `Added runtime dependency ${name}@${after}.`, detail: { name, after } });
    } else if (before !== undefined && after === undefined) {
      changes.push({ kind: "dependency_removed", summary: `Removed runtime dependency ${name}@${before}.`, detail: { name, before } });
    } else if (before !== undefined && after !== undefined && before !== after) {
      changes.push({ kind: "dependency_changed", summary: `Changed runtime dependency ${name}: ${before} → ${after}.`, detail: { name, before, after } });
    }
  }
  return changes;
}

function compareIndicators(baseline: Set<string>, candidate: Set<string>): ReportChange[] {
  const changes: ReportChange[] = [];
  for (const value of [...candidate].filter((item) => !baseline.has(item)).sort()) {
    changes.push({ kind: "indicator_added", summary: `Added static API indicator: ${value}.`, detail: { indicator: value } });
  }
  for (const value of [...baseline].filter((item) => !candidate.has(item)).sort()) {
    changes.push({ kind: "indicator_removed", summary: `Removed static API indicator: ${value}.`, detail: { indicator: value } });
  }
  return changes;
}

/**
 * Compare declared tool surfaces.
 *
 * Two guards matter more than the comparison. If either side has no inventory, no
 * tool conclusion is drawn at all — a baseline recorded before static extraction
 * existed would otherwise make every tool look newly added. If either extraction
 * was incomplete, a missing tool is inconclusive rather than removed, because the
 * extractor cannot distinguish a deleted tool from one it failed to parse.
 */
function compareTools(baseline: ToolInventory | undefined, candidate: ToolInventory | undefined): ReportChange[] {
  if (!baseline || !candidate) {
    return [{
      kind: "comparison_limited",
      summary: "Tool surface was not compared: one of the two reports carries no tool inventory.",
      detail: { reason: "missing_inventory" }
    }];
  }

  const changes: ReportChange[] = [];
  const reliableRemovals = baseline.complete && candidate.complete;

  for (const name of [...candidate.tools.keys()].sort()) {
    if (!baseline.tools.has(name)) {
      changes.push({ kind: "tool_added", summary: `Added tool: ${name}.`, detail: { tool: name } });
    }
  }

  for (const name of [...baseline.tools.keys()].sort()) {
    if (candidate.tools.has(name)) continue;
    changes.push(reliableRemovals
      ? { kind: "tool_removed", summary: `Removed tool: ${name}.`, detail: { tool: name } }
      : {
        kind: "comparison_limited",
        summary: `Tool ${name} is absent from the new report, but extraction was incomplete; this may be a parsing gap rather than a removal.`,
        detail: { reason: "incomplete_extraction", tool: name }
      });
  }

  for (const name of [...candidate.tools.keys()].sort()) {
    const before = baseline.tools.get(name);
    const after = candidate.tools.get(name);
    if (!before || !after) continue;

    if (before.input_schema_sha256 !== after.input_schema_sha256) {
      const added = addedProperties(before.input_schema_properties, after.input_schema_properties);
      changes.push({
        kind: "tool_schema_changed",
        summary: added.length > 0
          ? `Tool ${name} accepts new input fields: ${added.join(", ")}.`
          : `Tool ${name} input schema changed.`,
        detail: { tool: name, addedProperties: added }
      });
    }

    if (before.description_sha256 !== after.description_sha256) {
      changes.push({
        kind: "tool_description_changed",
        summary: `Tool ${name} description changed.`,
        detail: { tool: name }
      });
    }
  }

  if (!candidate.complete) {
    changes.push({
      kind: "comparison_limited",
      summary: "The new report's tool inventory is a lower bound: some sources could not be statically resolved.",
      detail: { reason: "incomplete_extraction" }
    });
  }

  return changes;
}

function addedProperties(before: string[] | undefined, after: string[] | undefined): string[] {
  if (!before || !after) return [];
  const known = new Set(before);
  return after.filter((property) => !known.has(property)).sort();
}

function compareMetadata(baseline: JsonObject, candidate: JsonObject): ReportChange[] {
  const changes: ReportChange[] = [];

  for (const field of ENTRYPOINT_FIELDS) {
    if (canonical(baseline[field]) === canonical(candidate[field])) continue;
    changes.push({
      kind: "entrypoint_changed",
      summary: `Package entrypoint "${field}" changed.`,
      detail: { field }
    });
  }

  const baselineScripts = isRecord(baseline.scripts) ? baseline.scripts : {};
  const candidateScripts = isRecord(candidate.scripts) ? candidate.scripts : {};
  for (const script of [...new Set([...Object.keys(baselineScripts), ...Object.keys(candidateScripts)])].sort()) {
    if (canonical(baselineScripts[script]) === canonical(candidateScripts[script])) continue;
    const install = INSTALL_SCRIPTS.has(script);
    changes.push({
      kind: install ? "install_script_changed" : "script_changed",
      summary: install
        ? `Install-time script "${script}" changed. npm runs this on the installing machine.`
        : `Package script "${script}" changed.`,
      detail: { script, installTime: install }
    });
  }

  if (canonical(baseline.mcpName) !== canonical(candidate.mcpName)) {
    changes.push({
      kind: "server_identity_changed",
      summary: `Declared MCP server name changed: ${describe(baseline.mcpName)} → ${describe(candidate.mcpName)}.`,
      detail: { before: baseline.mcpName ?? null, after: candidate.mcpName ?? null }
    });
  }

  for (const field of ["description", "engines"]) {
    if (canonical(baseline[field]) === canonical(candidate[field])) continue;
    changes.push({ kind: "metadata_changed", summary: `Package "${field}" changed.`, detail: { field } });
  }

  return changes;
}

/**
 * Files whose path is a declaration rather than an implementation detail.
 *
 * The Agent Plugins layout puts a package's declared surface in three fixed
 * places: `plugin.json` names the plugin, `mcp.json` says which MCP servers it
 * runs and over what transport, and each `skills/<name>/SKILL.md` is text a
 * model reads as instructions. A change to any of them alters what an agent
 * will do without necessarily altering a line of executable code.
 *
 * Recognising them is path matching, not inference — the same class of fact as
 * noticing that `package.json` declared a new script. Nothing here decides
 * whether a change is dangerous; that ranking belongs to the consumer.
 */
const PLUGIN_MANIFEST = "plugin.json";
const MCP_DECLARATION = "mcp.json";
const SKILL_FILE = /^skills\/[^/]+\/SKILL\.md$/;

/** npm archives root every entry at `package/`; plugin paths are relative to the root. */
function pluginPath(archivePath: string): string {
  return archivePath.startsWith("package/") ? archivePath.slice("package/".length) : archivePath;
}

function declaredSurfaceKind(archivePath: string): ChangeKind | undefined {
  const path = pluginPath(archivePath);
  if (path === PLUGIN_MANIFEST) return "plugin_manifest_changed";
  if (path === MCP_DECLARATION) return "mcp_declaration_changed";
  if (SKILL_FILE.test(path)) return "skill_changed";
  return undefined;
}

/**
 * How many changed paths to name before summarising.
 *
 * A routine release edits dozens of files and one entry per file would bury
 * what matters, but a bare count is not evidence. Naming a bounded sample keeps
 * the change readable while still pointing somewhere.
 */
const NAMED_PATH_LIMIT = 10;

/**
 * File inventory differences are summarized, not enumerated — except for the
 * declared-surface files above, which are named individually because a single
 * one of them changing is the whole point of watching a package.
 */
function compareFiles(
  baseline: Map<string, string | undefined> | undefined,
  candidate: Map<string, string | undefined> | undefined
): ReportChange[] {
  if (!baseline || !candidate) return [];

  const added = [...candidate.keys()].filter((path) => !baseline.has(path)).sort();
  const removed = [...baseline.keys()].filter((path) => !candidate.has(path)).sort();

  // Same path, different contents. Only comparable where both sides recorded a
  // digest; an entry without one carries no contents to have changed.
  const edited = [...candidate.entries()]
    .filter(([path, digest]) => {
      if (!baseline.has(path)) return false;
      const before = baseline.get(path);
      return before !== undefined && digest !== undefined && before !== digest;
    })
    .map(([path]) => path)
    .sort();

  const changes: ReportChange[] = [];

  // A declared-surface file gets its own change, whether it appeared, vanished
  // or was rewritten, so a consumer can rank it without parsing a summary.
  for (const [path, state] of [
    ...added.map((path) => [path, "added"] as const),
    ...removed.map((path) => [path, "removed"] as const),
    ...edited.map((path) => [path, "modified"] as const)
  ]) {
    const kind = declaredSurfaceKind(path);
    if (!kind) continue;
    changes.push({
      kind,
      summary: `${pluginPath(path)} was ${state}.`,
      detail: {
        path,
        state,
        ...(state === "modified"
          ? { baselineSha256: baseline.get(path), candidateSha256: candidate.get(path) }
          : {})
      }
    });
  }

  if (added.length > 0 || removed.length > 0) {
    changes.push({
      kind: "file_inventory_changed",
      summary: `File inventory changed: ${added.length} added, ${removed.length} removed.`,
      detail: { added, removed }
    });
  }

  if (edited.length > 0) {
    changes.push({
      kind: "file_content_changed",
      summary: `${edited.length} file${edited.length === 1 ? "" : "s"} changed contents without changing the inventory.`,
      detail: {
        count: edited.length,
        paths: edited.slice(0, NAMED_PATH_LIMIT),
        truncated: edited.length > NAMED_PATH_LIMIT
      }
    });
  }

  return changes;
}

function compareFindings(baseline: Map<string, ReportFinding>, candidate: Map<string, ReportFinding>): ReportChange[] {
  const changes: ReportChange[] = [];
  for (const [key, finding] of candidate) {
    if (baseline.has(key)) continue;
    changes.push({
      kind: "finding_added",
      summary: `New finding (${finding.category}): ${finding.summary}`,
      detail: { category: finding.category, severity: finding.severity, finding: finding.id }
    });
  }
  for (const [key, finding] of baseline) {
    if (candidate.has(key)) continue;
    changes.push({
      kind: "finding_removed",
      summary: `Finding no longer present (${finding.category}): ${finding.summary}`,
      detail: { category: finding.category, finding: finding.id }
    });
  }
  return changes;
}

function dependenciesFrom(observations: ReportObservation[]): Record<string, string> {
  const record = observations.find((item) => item.id === OBSERVATION_IDS.runtimeDependencies);
  const raw = record?.data.dependencies;
  if (!isRecord(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw)
      .filter((entry): entry is [string, string] => isString(entry[1]))
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function inventoryFrom(observations: ReportObservation[]): ToolInventory | undefined {
  const record = observations.find((item) => item.kind === OBSERVATION_KINDS.protocolInventory);
  if (!record || !Array.isArray(record.data.tools)) return undefined;
  const tools = new Map<string, ToolRecord>();
  for (const entry of record.data.tools) {
    if (!isRecord(entry) || !isString(entry.name)) continue;
    const tool: ToolRecord = { name: entry.name };
    if (isString(entry.description_sha256)) tool.description_sha256 = entry.description_sha256;
    if (isString(entry.input_schema_sha256)) tool.input_schema_sha256 = entry.input_schema_sha256;
    if (Array.isArray(entry.input_schema_properties)) {
      tool.input_schema_properties = entry.input_schema_properties.filter(isString);
    }
    tools.set(tool.name, tool);
  }
  return { tools, complete: record.data.complete === true };
}

function metadataFrom(observations: ReportObservation[]): JsonObject {
  const record = observations.find((item) => item.id === OBSERVATION_IDS.packageMetadata);
  if (!record) return {};
  return Object.fromEntries(Object.entries(record.data).filter(([key]) => !VOLATILE_METADATA.has(key)));
}

function filesFrom(observations: ReportObservation[]): Map<string, string | undefined> | undefined {
  const record = observations.find((item) => item.id === OBSERVATION_IDS.fileInventory);
  if (!record || !Array.isArray(record.data.entries)) return undefined;
  const files = new Map<string, string | undefined>();
  for (const entry of record.data.entries) {
    if (isRecord(entry) && isString(entry.path)) {
      files.set(entry.path, isString(entry.sha256) ? entry.sha256 : undefined);
    }
  }
  return files;
}

function shortHash(value: string): string {
  return `${value.slice(0, 12)}…`;
}

/** Order-independent comparable form for an arbitrary package.json value. */
function canonical(value: unknown): string {
  if (value === undefined) return " undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function describe(value: unknown): string {
  return isString(value) ? value : "(absent)";
}
