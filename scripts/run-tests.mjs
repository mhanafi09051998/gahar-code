import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = fileURLToPath(new URL("..", import.meta.url));

async function findTests(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findTests(full)));
    else if (entry.isFile() && entry.name.endsWith(".test.mjs")) found.push(full);
  }
  return found;
}

const tests = (await findTests(join(root, "test"))).sort();
if (tests.length === 0) {
  console.error("No test files found under test/");
  process.exit(1);
}
console.log(`Running ${tests.length} test file(s)...`);
const result = spawnSync(process.execPath, ["--test", ...tests], {
  cwd: root,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
