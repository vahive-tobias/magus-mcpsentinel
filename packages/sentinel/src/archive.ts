import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const BLOCK_SIZE = 512;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

export interface TarEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "hardlink";
  size: number;
  contents?: Buffer;
}

export interface NpmArchive {
  compressed: Buffer;
  entries: TarEntry[];
}

export async function readNpmArchive(archivePath: string): Promise<NpmArchive> {
  const compressed = await readFile(archivePath);
  return readNpmArchiveBytes(compressed);
}

export function readNpmArchiveBytes(compressed: Buffer): NpmArchive {
  if (compressed.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`Archive exceeds the ${MAX_ARCHIVE_BYTES} byte compressed-size limit.`);
  }

  let tar: Buffer;
  try {
    tar = gunzipSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  } catch (error) {
    throw new Error(`Unable to safely decompress gzip archive: ${messageOf(error)}`);
  }

  const entries: TarEntry[] = [];
  // A GNU long-name or pax extended header carries the real path for the entry
  // that follows it. Its own header name is a placeholder such as `././@LongLink`,
  // which is not a package path and must never be treated as one.
  let overridePath: string | undefined;
  let overrideSize: number | undefined;

  for (let offset = 0; offset + BLOCK_SIZE <= tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    if (entries.length >= MAX_ENTRIES) {
      throw new Error(`Archive exceeds the ${MAX_ENTRIES} entry limit.`);
    }

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const size = readTarSize(header);
    const typeFlag = String.fromCharCode(header[156] || 0);
    const contentStart = offset + BLOCK_SIZE;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.length) {
      throw new Error(`Archive entry ${JSON.stringify(name)} exceeds the decompressed archive boundary.`);
    }
    const advance = contentStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

    // Metadata entries describe the next entry rather than contributing one.
    if (typeFlag === "L") {
      overridePath = readNulTerminated(tar.subarray(contentStart, contentEnd));
      offset = advance;
      continue;
    }
    if (typeFlag === "K") {
      // Long link target. Consumed so the stream stays aligned; link targets are
      // not part of the reported inventory.
      offset = advance;
      continue;
    }
    if (typeFlag === "x" || typeFlag === "g") {
      const records = parsePaxRecords(tar.subarray(contentStart, contentEnd));
      // A global header (`g`) sets defaults for the rest of the archive; npm does
      // not use it for paths, so only per-entry (`x`) overrides are applied.
      if (typeFlag === "x") {
        const paxPath = records.get("path");
        if (paxPath !== undefined) overridePath = paxPath;
        const paxSize = records.get("size");
        if (paxSize !== undefined && /^[0-9]+$/.test(paxSize)) {
          const parsed = Number.parseInt(paxSize, 10);
          if (Number.isSafeInteger(parsed) && parsed >= 0) overrideSize = parsed;
        }
      }
      offset = advance;
      continue;
    }

    const rawPath = overridePath ?? (prefix ? `${prefix}/${name}` : name);
    const entrySize = overrideSize ?? size;
    overridePath = undefined;
    overrideSize = undefined;

    const archivePath = normalizePackagePath(rawPath);
    const entryContentEnd = contentStart + entrySize;
    if (entryContentEnd > tar.length) {
      throw new Error(`Archive entry ${archivePath} exceeds the decompressed archive boundary.`);
    }

    const type = entryType(typeFlag, archivePath);
    entries.push({
      path: archivePath,
      type,
      size: entrySize,
      ...(type === "file" ? { contents: tar.subarray(contentStart, entryContentEnd) } : {})
    });

    offset = contentStart + Math.ceil(entrySize / BLOCK_SIZE) * BLOCK_SIZE;
  }

  if (overridePath !== undefined) {
    throw new Error("Archive ends with a long-name or extended header that describes no entry.");
  }

  return { compressed, entries };
}

function readNulTerminated(buffer: Buffer): string {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end === -1 ? buffer.length : end).toString("utf8");
}

/**
 * Parse pax extended header records, each encoded as `LENGTH key=value\n` where
 * LENGTH counts the whole record including its own digits. A malformed record
 * stops parsing rather than guessing at the remainder.
 */
function parsePaxRecords(buffer: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space === -1) break;
    const declared = buffer.subarray(offset, space).toString("ascii");
    if (!/^[0-9]+$/.test(declared)) break;
    const length = Number.parseInt(declared, 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > buffer.length) break;
    const payload = buffer.subarray(space + 1, offset + length).toString("utf8").replace(/\n$/, "");
    const separator = payload.indexOf("=");
    if (separator > 0) {
      records.set(payload.slice(0, separator), payload.slice(separator + 1));
    }
    offset += length;
  }
  return records;
}

function readTarString(buffer: Buffer, start: number, length: number): string {
  const value = buffer.subarray(start, start + length);
  const end = value.indexOf(0);
  return value.subarray(0, end === -1 ? value.length : end).toString("utf8").trim();
}

function readTarSize(header: Buffer): number {
  const value = readTarString(header, 124, 12);
  if (!value) {
    return 0;
  }
  if (!/^[0-7]+$/.test(value)) {
    throw new Error(`Unsupported tar size encoding: ${JSON.stringify(value)}.`);
  }
  const size = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Tar entry size is invalid.");
  }
  return size;
}

function normalizePackagePath(value: string): string {
  if (!value || value.startsWith("/") || value.includes("\\")) {
    throw new Error(`Unsafe archive path: ${JSON.stringify(value)}.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Unsafe archive path: ${JSON.stringify(value)}.`);
  }
  if (segments[0] !== "package") {
    throw new Error(`npm archive entry is outside the package root: ${JSON.stringify(value)}.`);
  }
  return segments.join("/");
}

function entryType(flag: string, archivePath: string): TarEntry["type"] {
  switch (flag) {
    case "\0":
    case "0":
    case "7":
      return "file";
    case "5":
      return "directory";
    case "2":
      return "symlink";
    case "1":
      return "hardlink";
    default:
      throw new Error(`Unsupported tar entry type ${JSON.stringify(flag)} for ${archivePath}.`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
