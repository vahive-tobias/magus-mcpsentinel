import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readNpmArchiveBytes, type NpmArchive, type ReadArchiveOptions } from "./archive.js";
import type { AcquiredNpmPackage } from "./npm-registry.js";

/**
 * The parts of the analyzer that touch a filesystem.
 *
 * They live here, and only here, so that every other analyzer module can be
 * imported by a host that has no filesystem. Keeping an unused `node:fs` import
 * in a shared module would leave that working only for as long as the consumer's
 * bundler happened to stub it.
 *
 * Nothing reachable from the `./analyze` export may import this file.
 */

export async function readNpmArchive(archivePath: string, options: ReadArchiveOptions = {}): Promise<NpmArchive> {
  return readNpmArchiveBytes(await readFile(archivePath), options);
}

/**
 * Write the registry's unmodified metadata and the downloaded artifact, each named
 * by its own digest.
 *
 * An existing path is only tolerated when its contents are identical, so preserved
 * evidence can never be silently replaced.
 */
export async function preserveAcquisitionEvidence(
  acquisition: AcquiredNpmPackage,
  evidenceDirectory: string
): Promise<{ metadataPath: string; tarballPath: string }> {
  await mkdir(evidenceDirectory, { recursive: true });
  const prefix = `${safeFileComponent(acquisition.request.packageName)}-${safeFileComponent(acquisition.request.version)}`;
  const metadataPath = join(evidenceDirectory, `${prefix}-metadata-${acquisition.metadataSha256}.json`);
  const tarballPath = join(evidenceDirectory, `${prefix}-artifact-${acquisition.tarballSha256}.tgz`);
  await writeNewOrIdentical(metadataPath, acquisition.metadata);
  await writeNewOrIdentical(tarballPath, acquisition.tarball);
  return { metadataPath, tarballPath };
}

async function writeNewOrIdentical(path: string, contents: Buffer): Promise<void> {
  try {
    await writeFile(path, contents, { flag: "wx" });
  } catch (error) {
    if (!isCode(error, "EEXIST")) {
      throw error;
    }
    const existing = await readFile(path);
    if (existing.length !== contents.length || !existing.equals(contents)) {
      throw new Error(`Evidence path already exists with different content: ${path}`);
    }
  }
}

function safeFileComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function isCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
