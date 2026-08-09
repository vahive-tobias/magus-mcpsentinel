/**
 * The Sentinel evidence report contract.
 *
 * This module is the single definition of the report's shape and of the
 * identifiers used inside it. Both the writer (`report.ts`) and the reader
 * (`diff.ts`) import from here, so renaming an observation is a compile error
 * rather than a change class that silently stops being detected.
 *
 * It is deliberately dependency-free — no Node built-ins, no packages — so that
 * a consumer running in a constrained runtime (an edge worker, a browser) can
 * import it and the diff alongside it.
 */

/**
 * The format this build *writes*.
 *
 * `schemas/report.schema.json` pins `format_version` to this exact value, so a
 * freshly generated report that does not carry it fails validation. That is the
 * intended behaviour: the schema's job is to catch the analyzer emitting
 * something stale, not to admit every report ever written.
 */
export const FORMAT_VERSION = "0.2.0";

/**
 * The formats this build can *read*. Anything else is refused, not guessed at.
 *
 * Deliberately wider than `FORMAT_VERSION`, and the difference is load-bearing:
 * a monitor holds baselines recorded by older builds, and a baseline that stops
 * being comparable silently loses the history a change notice is measured
 * against. Reading is permissive; writing is exact.
 *
 * So `validateReport` (schema, generation-time, exact) and `assertSentinelReport`
 * (shape, read-time, permissive) disagreeing about `0.1.0` is correct. Widening
 * the schema to match this list would let the analyzer emit an outdated format
 * unnoticed — the failure this split exists to prevent. `format-contract.test.ts`
 * holds the two in step.
 */
export const SUPPORTED_FORMATS: readonly string[] = ["0.1.0", "0.2.0"];

/** Stable observation identifiers. Changing one is a format change. */
export const OBSERVATION_IDS = {
  packageMetadata: "observation:package-metadata",
  fileInventory: "observation:file-inventory",
  registryMetadata: "observation:registry-metadata",
  runtimeDependencies: "observation:runtime-dependencies",
  staticToolInventory: "observation:static-tool-inventory"
} as const;

export const OBSERVATION_KINDS = {
  artifactMetadata: "artifact_metadata",
  file: "file",
  dependency: "dependency",
  codeIndicator: "code_indicator",
  protocolInventory: "protocol_inventory"
} as const;

export type JsonObject = Record<string, unknown>;

export interface ReportArtifact {
  ecosystem: "npm";
  package: string;
  version: string;
  sha256: string;
  acquired_at: string;
  [key: string]: unknown;
}

export interface ReportObservation {
  id: string;
  kind: string;
  coverage: string;
  data: JsonObject;
  [key: string]: unknown;
}

export interface ReportFinding {
  id: string;
  category: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  summary: string;
  [key: string]: unknown;
}

export interface SentinelReport {
  format_version: string;
  report_id: string;
  generated_at: string;
  subject: {
    server_name: string;
    artifact: ReportArtifact;
    [key: string]: unknown;
  };
  observations: ReportObservation[];
  findings: ReportFinding[];
  limitations: Array<{ code: string; summary: string }>;
  [key: string]: unknown;
}

/**
 * Structural validation of an untrusted report.
 *
 * This is not schema validation — `schemas/report.schema.json` remains the full
 * contract. It establishes only what the diff needs in order to be safe.
 */
export function assertSentinelReport(value: unknown): asserts value is SentinelReport {
  if (!isRecord(value) || !isString(value.format_version) || !SUPPORTED_FORMATS.includes(value.format_version)) {
    throw new Error(`Expected a Sentinel evidence report in a supported format (${SUPPORTED_FORMATS.join(", ")}).`);
  }
  if (!isRecord(value.subject) || !isRecord(value.subject.artifact)) {
    throw new Error("Report must contain a subject artifact.");
  }
  const artifact = value.subject.artifact;
  if (artifact.ecosystem !== "npm" || !isString(artifact.package) || !isString(artifact.version) || !isSha256(artifact.sha256)) {
    throw new Error("Report subject must identify an npm artifact with a SHA-256 digest.");
  }
  if (!Array.isArray(value.observations) || !Array.isArray(value.findings)) {
    throw new Error("Report must contain observations and findings arrays.");
  }
}

export function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isSha256(value: unknown): value is string {
  return isString(value) && /^[a-f0-9]{64}$/.test(value);
}
