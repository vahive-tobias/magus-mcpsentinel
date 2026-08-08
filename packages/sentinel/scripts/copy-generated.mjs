// tsc emits only what it compiles, and the precompiled validator is generated
// JavaScript rather than TypeScript. Copy it into the build output so the
// compiled analyzer can resolve it at runtime.
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(packageRoot, "src", "generated");
const to = join(packageRoot, "dist", "src", "generated");

await mkdir(to, { recursive: true });
for (const entry of await readdir(from)) {
  if (entry.endsWith(".mjs")) await copyFile(join(from, entry), join(to, entry));
}
