import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export interface NpmPackageRequest {
  packageName: string;
  version: string;
}

export interface AcquiredNpmPackage {
  request: NpmPackageRequest;
  acquiredAt: string;
  metadataUrl: string;
  metadata: Buffer;
  metadataSha256: string;
  tarballUrl: string;
  tarball: Buffer;
  tarballSha256: string;
  integrityClaim?: string;
  integrityVerified: boolean;
}

export type FetchImplementation = (input: string, init?: RequestInit) => Promise<Response>;

export function parseNpmSpecifier(specifier: string): NpmPackageRequest {
  const separator = specifier.lastIndexOf("@");
  const scopeSeparator = specifier.startsWith("@") ? specifier.indexOf("/") : -1;
  if (separator <= scopeSeparator || separator <= 0 || separator === specifier.length - 1) {
    throw new Error("npm specifier must use the exact form <package>@<version> (for example @scope/package@1.2.3).");
  }
  const packageName = specifier.slice(0, separator);
  const version = specifier.slice(separator + 1);
  if (!isSafePackageName(packageName) || /[\\/]/.test(version)) {
    throw new Error("npm specifier contains an unsafe package name or version.");
  }
  return { packageName, version };
}

export async function acquireNpmPackage(
  request: NpmPackageRequest,
  registry = "https://registry.npmjs.org",
  fetchImplementation: FetchImplementation = fetch
): Promise<AcquiredNpmPackage> {
  const registryBase = normalizeRegistry(registry);
  const metadataUrl = `${registryBase}/${encodeURIComponent(request.packageName)}/${encodeURIComponent(request.version)}`;
  const metadata = await fetchBytes(fetchImplementation, metadataUrl, MAX_METADATA_BYTES, "application/json");
  const versionMetadata = parseVersionMetadata(metadata, request);
  const dist = requiredObject(versionMetadata, "dist");
  const tarballUrl = requiredString(dist, "tarball");
  validateRemoteUrl(tarballUrl, "tarball URL");
  const integrityClaim = optionalString(dist, "integrity");
  const tarball = await fetchBytes(fetchImplementation, tarballUrl, MAX_TARBALL_BYTES, "application/octet-stream");
  if (integrityClaim) {
    verifyIntegrity(tarball, integrityClaim);
  }

  return {
    request,
    acquiredAt: new Date().toISOString(),
    metadataUrl,
    metadata,
    metadataSha256: sha256(metadata),
    tarballUrl,
    tarball,
    tarballSha256: sha256(tarball),
    integrityClaim,
    integrityVerified: Boolean(integrityClaim)
  };
}

export async function preserveAcquisitionEvidence(acquisition: AcquiredNpmPackage, evidenceDirectory: string): Promise<{ metadataPath: string; tarballPath: string }> {
  await mkdir(evidenceDirectory, { recursive: true });
  const prefix = `${safeFileComponent(acquisition.request.packageName)}-${safeFileComponent(acquisition.request.version)}`;
  const metadataPath = join(evidenceDirectory, `${prefix}-metadata-${acquisition.metadataSha256}.json`);
  const tarballPath = join(evidenceDirectory, `${prefix}-artifact-${acquisition.tarballSha256}.tgz`);
  await writeNewOrIdentical(metadataPath, acquisition.metadata);
  await writeNewOrIdentical(tarballPath, acquisition.tarball);
  return { metadataPath, tarballPath };
}

async function fetchBytes(fetchImplementation: FetchImplementation, url: string, maximumBytes: number, accept: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      headers: { accept },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`Request failed for ${url}: ${messageOf(error)}`);
  }
  if (!response.ok) {
    throw new Error(`Registry request failed for ${url}: HTTP ${response.status}.`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`Response for ${url} exceeds the ${maximumBytes} byte limit.`);
  }
  if (!response.body) {
    throw new Error(`Response for ${url} has no body.`);
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > maximumBytes) {
        throw new Error(`Response for ${url} exceeds the ${maximumBytes} byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function parseVersionMetadata(metadata: Buffer, request: NpmPackageRequest): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(metadata.toString("utf8"));
  } catch (error) {
    throw new Error(`Registry returned invalid JSON metadata: ${messageOf(error)}`);
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Registry metadata must be a JSON object.");
  }
  const result = value as JsonObject;
  if (requiredString(result, "name") !== request.packageName || requiredString(result, "version") !== request.version) {
    throw new Error("Registry metadata identity does not match the requested package and version.");
  }
  return result;
}

function verifyIntegrity(tarball: Buffer, integrity: string): void {
  const [entry] = integrity.split(/\s+/);
  const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(entry ?? "");
  if (!match) {
    throw new Error("Registry integrity claim is malformed or uses an unsupported algorithm.");
  }
  const [, algorithm, encodedDigest] = match;
  const expected = Buffer.from(encodedDigest, "base64");
  const actual = createHash(algorithm).update(tarball).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("Downloaded tarball does not match the registry integrity claim.");
  }
}

function normalizeRegistry(registry: string): string {
  let url: URL;
  try {
    url = new URL(registry);
  } catch {
    throw new Error("Registry must be an absolute HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Registry must be an absolute HTTPS URL without credentials, query, or fragment.");
  }
  return url.toString().replace(/\/$/, "");
}

function validateRemoteUrl(value: string, label: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error();
    }
  } catch {
    throw new Error(`Registry ${label} must be an HTTPS URL without credentials.`);
  }
}

function requiredObject(value: JsonObject, key: string): JsonObject {
  const candidate = value[key];
  if (!candidate || Array.isArray(candidate) || typeof candidate !== "object") {
    throw new Error(`Registry metadata must contain an object ${JSON.stringify(key)}.`);
  }
  return candidate as JsonObject;
}

function requiredString(value: JsonObject, key: string): string {
  const candidate = optionalString(value, key);
  if (!candidate) {
    throw new Error(`Registry metadata must contain a non-empty string ${JSON.stringify(key)}.`);
  }
  return candidate;
}

function optionalString(value: JsonObject, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function isSafePackageName(packageName: string): boolean {
  const pattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
  return pattern.test(packageName);
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

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type JsonObject = Record<string, unknown>;
