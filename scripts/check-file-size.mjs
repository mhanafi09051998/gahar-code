import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = fileURLToPath(new URL("..", import.meta.url));
const roots = ["src", "test", "scripts"];
const limit = 300;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile() && /\.(ts|mjs|js)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const files = (await Promise.all(roots.map((dir) => walk(join(root, dir))))).flat();
const violations = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  const lines = text.split(/\r?\n/).length;
  if (lines > limit) violations.push([file, lines]);
}
if (violations.length > 0) {
  for (const [file, lines] of violations) {
    console.error(`${file}: ${lines} lines (limit ${limit})`);
  }
  process.exit(1);
}
console.log(`File size check passed (${files.length} files, limit ${limit} lines).`);
