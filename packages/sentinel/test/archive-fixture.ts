import { gzipSync } from "node:zlib";

export interface RawTarEntry {
  /** Name written into the 100-byte header field. */
  name: string;
  contents: Buffer | string;
  /** Tar type flag. "0" is a regular file; "L", "K", "x" and "g" are metadata entries. */
  typeFlag?: string;
  /** Overrides the size written into the header. Used only to build malformed fixtures. */
  declaredSize?: number;
}

/** Build a tar entry header plus its padded content blocks. */
function tarBlocks(entry: RawTarEntry): Buffer[] {
  const contents = Buffer.isBuffer(entry.contents) ? entry.contents : Buffer.from(entry.contents, "utf8");
  const size = entry.declaredSize ?? contents.length;
  const header = Buffer.alloc(512);
  header.write(entry.name, 0, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.fill(0x20, 148, 156);
  header.write(entry.typeFlag ?? "0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return [header, contents, Buffer.alloc((512 - (contents.length % 512)) % 512)];
}

/** Assemble an arbitrary tar stream. Use for archives that need metadata entries. */
export function createRawTarball(entries: RawTarEntry[]): Buffer {
  const blocks = entries.flatMap(tarBlocks);
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** Assemble a plain ustar npm tarball from a path-to-contents map. */
export function createNpmTarball(entries: Record<string, string>): Buffer {
  return createRawTarball(Object.entries(entries).map(([name, contents]) => ({ name, contents })));
}

/**
 * Encode a pax extended header payload. Each record is `LENGTH key=value\n`,
 * where LENGTH counts the entire record including its own digits.
 */
export function paxRecords(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => {
      const body = ` ${key}=${value}\n`;
      let length = body.length + 1;
      // The digit count is part of the length, so it can push the total over a
      // power of ten. Settle on a fixed point.
      while (String(length).length + body.length !== length) {
        length = String(length).length + body.length;
      }
      return `${length}${body}`;
    })
    .join("");
}
