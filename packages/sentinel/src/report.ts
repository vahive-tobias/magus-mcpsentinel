import { createHash, randomUUID } from "node:crypto";
import { ANALYZER_BUILD_SHA256 } from "./build-info.js";
import type { NpmArchive, TarEntry } from "./archive.js";
import { extractToolSurface } from "./tool-surface.js";
import { evaluateRules, RULE_PACK_VERSION, rulePackSha256 } from "./rules.js";
import { FORMAT_VERSION, OBSERVATION_IDS, OBSERVATION_KINDS } from "./report-contract.js";

export type JsonObject = Record<string, unknown>;

export interface AcquisitionEvidence {
  requestedPackage: string;
  requestedVersion: string;
  acquiredAt: string;
  metadataUrl: string;
  metadataSha256: string;
  tarballUrl: string;
  integrityClaim?: string;
  integrityVerified: boolean;
}

export async function createStaticReport(archive: NpmArchive, acquisition?: AcquisitionEvidence): Promise<JsonObject> {
  const packageEntry = archive.entries.find((entry) => entry.path === "package/package.json" && entry.type === "file");
  if (!packageEntry?.contents) {
    throw new Error("The npm archive does not contain a regular package/package.json file.");
  }

  const packageJson = parsePackageJson(packageEntry);
  const packageName = requiredString(packageJson, "name");
  const version = requiredString(packageJson, "version");
  if (acquisition && (acquisition.requestedPackage !== packageName || acquisition.requestedVersion !== version)) {
    throw new Error(`Downloaded artifact identifies as ${packageName}@${version}, not requested ${acquisition.requestedPackage}@${acquisition.requestedVersion}.`);
  }
  const artifactSha256 = sha256(archive.compressed);
  const packageEvidence = evidenceFor(packageEntry);
  const fileInventory = archive.entries
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(fileRecord);
  const fileBytes = archive.entries
    .filter((entry) => entry.type === "file")
    .reduce((total, entry) => total + entry.size, 0);

  const observations: JsonObject[] = [
    {
      id: OBSERVATION_IDS.packageMetadata,
      kind: OBSERVATION_KINDS.artifactMetadata,
      coverage: "declared",
      evidence: [packageEvidence],
      data: packageMetadata(packageJson)
    },
    {
      id: OBSERVATION_IDS.fileInventory,
      kind: OBSERVATION_KINDS.file,
      coverage: "declared",
      evidence: [{ sha256: artifactSha256, capture_kind: "artifact_file" }],
      data: { entry_count: fileInventory.length, regular_file_bytes: fileBytes, entries: fileInventory }
    }
  ];

  if (acquisition) {
    observations.push({
      id: OBSERVATION_IDS.registryMetadata,
      kind: OBSERVATION_KINDS.artifactMetadata,
      coverage: "declared",
      evidence: [{ sha256: acquisition.metadataSha256, capture_kind: "registry_metadata" }],
      data: {
        metadata_url: acquisition.metadataUrl,
        requested_package: acquisition.requestedPackage,
        requested_version: acquisition.requestedVersion,
        tarball_url: acquisition.tarballUrl,
        integrity_claim: acquisition.integrityClaim,
        integrity_verified: acquisition.integrityVerified
      }
    });
  }

  const dependencies = objectProperty(packageJson, "dependencies");
  if (dependencies && Object.keys(dependencies).length > 0) {
    observations.push({
      id: OBSERVATION_IDS.runtimeDependencies,
      kind: OBSERVATION_KINDS.dependency,
      coverage: "declared",
      evidence: [packageEvidence],
      data: { dependencies: sortObject(dependencies) }
    });
  }

  observations.push(...staticIndicatorObservations(archive.entries));

  // Statically inferred MCP tool surface. This is not a protocol observation:
  // no server was started and no tools/list request was ever sent.
  const toolSurface = extractToolSurface(archive.entries);
  observations.push({
    id: OBSERVATION_IDS.staticToolInventory,
    kind: OBSERVATION_KINDS.protocolInventory,
    coverage: "inferred",
    evidence: [{ sha256: artifactSha256, capture_kind: "artifact_file" }],
    data: {
      extraction: "static_source_analysis",
      complete: toolSurface.complete,
      incompleteness: toolSurface.incompleteness,
      scanned_files: toolSurface.scanned_files,
      tools: toolSurface.tools
    }
  });

  const limitations: JsonObject[] = [
    { code: "protocol_discovery_not_run", summary: "M1 performs static artifact inspection only; no MCP protocol session was opened." },
    { code: "tool_calls_not_performed", summary: "No tools were invoked." },
    { code: "semantic_analysis_not_run", summary: "No semantic model analysis was run." }
  ];
  if (!toolSurface.complete) {
    limitations.push({
      code: "static_tool_extraction_incomplete",
      summary: `The declared tool surface could not be fully resolved from source (${toolSurface.incompleteness.join(", ")}). Treat the inventory as a lower bound, not a complete list.`
    });
  }

  return {
    format_version: FORMAT_VERSION,
    report_id: randomUUID(),
    generated_at: new Date().toISOString(),
    subject: {
      server_name: optionalString(packageJson, "mcpName") ?? packageName,
      ...(packageName.startsWith("@") ? { publisher_claim: packageName.split("/")[0] } : {}),
      artifact: {
        ecosystem: "npm",
        package: packageName,
        version,
        sha256: artifactSha256,
        ...(acquisition ? {
          download_url: acquisition.tarballUrl,
          registry_metadata_url: acquisition.metadataUrl,
          acquired_at: acquisition.acquiredAt,
          registry_metadata_sha256: acquisition.metadataSha256,
          integrity_claim: acquisition.integrityClaim,
          integrity_verified: acquisition.integrityVerified
        } : { acquired_at: new Date().toISOString() })
      }
    },
    analysis: {
      engine: { name: "sentinel", version: "0.2.0", build_sha256: ANALYZER_BUILD_SHA256 },
      protocol_profile: {
        id: "mcp-2026-07-28",
        specification_revision: "2026-07-28",
        local_retrieval_date: "2026-08-01",
        discovery_status: "not_run"
      },
      authorization_profiles: [{ id: "none", credential_present: false, description: "No credentials were supplied." }],
      rule_pack: { version: RULE_PACK_VERSION, sha256: rulePackSha256() },
      semantic_analysis: []
    },
    observations,
    // Raw agent-visible text is passed to the rules but never serialized: findings
    // reference it by digest and byte range so an alert can cite text without
    // reproducing it.
    findings: evaluateRules({
      packageJson,
      packageJsonEvidence: {
        sha256: sha256(packageEntry.contents ?? ""),
        artifact_path: packageEntry.path,
        capture_kind: "artifact_file"
      },
      agentText: toolSurface.agentText
    }),
    limitations
  };
}

function parsePackageJson(entry: TarEntry): JsonObject {
  try {
    const parsed = JSON.parse(entry.contents?.toString("utf8") ?? "") as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("package.json must be a JSON object.");
    }
    return parsed as JsonObject;
  } catch (error) {
    throw new Error(`Invalid package/package.json: ${messageOf(error)}`);
  }
}

function packageMetadata(packageJson: JsonObject): JsonObject {
  const keys = ["name", "version", "mcpName", "description", "main", "bin", "scripts", "engines"];
  const metadata: Array<[string, unknown]> = [];
  for (const key of keys) {
    if (packageJson[key] !== undefined) {
      metadata.push([key, packageJson[key]]);
    }
  }
  return Object.fromEntries(metadata);
}

function fileRecord(entry: TarEntry): JsonObject {
  return {
    path: entry.path,
    type: entry.type,
    size: entry.size,
    ...(entry.contents ? { sha256: sha256(entry.contents) } : {})
  };
}

function staticIndicatorObservations(entries: TarEntry[]): JsonObject[] {
  const indicators: Array<{ id: string; pattern: RegExp; description: string }> = [
    { id: "network-api", pattern: /\b(?:fetch|https?\.request|net\.connect)\s*\(/, description: "Source references a network API." },
    { id: "filesystem-api", pattern: /\b(?:readFile|writeFile|rm|unlink|readdir|createReadStream|createWriteStream)\s*\(/, description: "Source references a filesystem API." },
    { id: "process-spawn-api", pattern: /\b(?:spawn|exec|execFile|fork)\s*\(/, description: "Source references a process-spawning API." }
  ];
  const observations: JsonObject[] = [];
  for (const entry of entries) {
    if (!entry.contents || !/\.(?:[cm]?js|ts)$/i.test(entry.path)) {
      continue;
    }
    const source = entry.contents.toString("utf8");
    for (const indicator of indicators) {
      const match = indicator.pattern.exec(source);
      if (match?.index !== undefined) {
        observations.push({
          id: `observation:${indicator.id}-${sha256(`${entry.path}:${match.index}`).slice(0, 16)}`,
          kind: OBSERVATION_KINDS.codeIndicator,
          coverage: "inferred",
          evidence: [{ ...evidenceFor(entry), byte_range: [match.index, match.index + match[0].length] }],
          data: { indicator: indicator.id, description: indicator.description }
        });
      }
    }
  }
  return observations;
}

function evidenceFor(entry: TarEntry): JsonObject {
  return {
    sha256: sha256(entry.contents ?? ""),
    artifact_path: entry.path,
    capture_kind: "artifact_file"
  };
}

function objectProperty(value: JsonObject, key: string): JsonObject | undefined {
  const candidate = value[key];
  return candidate && !Array.isArray(candidate) && typeof candidate === "object" ? candidate as JsonObject : undefined;
}

function requiredString(value: JsonObject, key: string): string {
  const candidate = optionalString(value, key);
  if (!candidate) {
    throw new Error(`package/package.json must contain a non-empty string ${JSON.stringify(key)}.`);
  }
  return candidate;
}

function optionalString(value: JsonObject, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function sortObject(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
