import { ArchiveTooLargeError, readNpmArchiveBytes } from "./archive.js";
import { acquireNpmPackage, type FetchImplementation, type NpmPackageRequest } from "./npm-registry.js";
import { createStaticReport } from "./report.js";
import { validateReport } from "./schema.js";
import type { SentinelReport } from "./report-contract.js";

/**
 * The analyzer as one call, for hosts without a filesystem.
 *
 * This is the only analysis entry point the package exports. Everything reachable
 * from here is portable: no filesystem, no subprocess, no schema compiled at
 * runtime. `--evidence-dir` preservation is deliberately absent — it writes files,
 * and a caller that cannot write files has nowhere to put them.
 *
 * As everywhere else in the analyzer, the package is never executed.
 */

export { ArchiveTooLargeError } from "./archive.js";
// Exported so a consumer can list what the tool-surface scan skipped without
// re-deriving the rule. Path-shape exclusion is an approximation rather than
// proof of runtime irrelevance, and it should stay inspectable.
export { isOutsideToolSurface } from "./tool-surface.js";
export { ReportValidationError } from "./schema.js";
export type { NpmPackageRequest } from "./npm-registry.js";

export interface AnalyzeOptions {
  /**
   * Ceiling on the decompressed artifact.
   *
   * A host with less memory than the analyzer's default bound must say so. Exceeding
   * it raises `ArchiveTooLargeError`, which a caller is expected to record as a
   * coverage limit — never as a clean result, and never as a finding about the
   * package.
   */
  maxUncompressedBytes?: number;
  registry?: string;
  fetchImplementation?: FetchImplementation;
}

export interface AnalyzedPackage {
  report: SentinelReport;
  artifactSha256: string;
  compressedBytes: number;
  entryCount: number;
}

export async function analyzeNpmPackage(request: NpmPackageRequest, options: AnalyzeOptions = {}): Promise<AnalyzedPackage> {
  const acquisition = await acquireNpmPackage(
    request,
    options.registry ?? "https://registry.npmjs.org",
    options.fetchImplementation ?? fetch
  );

  const archive = readNpmArchiveBytes(acquisition.tarball, {
    ...(options.maxUncompressedBytes === undefined ? {} : { maxUncompressedBytes: options.maxUncompressedBytes })
  });

  const report = await createStaticReport(archive, {
    requestedPackage: acquisition.request.packageName,
    requestedVersion: acquisition.request.version,
    acquiredAt: acquisition.acquiredAt,
    metadataUrl: acquisition.metadataUrl,
    metadataSha256: acquisition.metadataSha256,
    tarballUrl: acquisition.tarballUrl,
    ...(acquisition.integrityClaim === undefined ? {} : { integrityClaim: acquisition.integrityClaim }),
    integrityVerified: acquisition.integrityVerified
  });

  // A report that does not conform to its own schema is not a weaker report, it
  // is an analyzer bug. Refuse it here rather than let a consumer store it.
  await validateReport(report);

  return {
    report: report as unknown as SentinelReport,
    artifactSha256: acquisition.tarballSha256,
    compressedBytes: acquisition.tarball.byteLength,
    entryCount: archive.entries.length
  };
}

/** True when analysis failed only because the artifact exceeds the host's limit. */
export function isArchiveTooLarge(error: unknown): error is ArchiveTooLargeError {
  return error instanceof ArchiveTooLargeError;
}
