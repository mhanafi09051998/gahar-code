import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { GOOD_KEY, startMockOpenRouter } from "./mock-openrouter.mjs";

const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

let mock;
const dirs = [];

before(async () => {
  mock = await startMockOpenRouter();
});

after(async () => {
  await mock.close();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Runs dist/cli.js headless in a fresh workspace against the mock server. */
async function runCli(args, { apiKey = GOOD_KEY } = {}) {
  const cwd = await tempDir("gahar-cli-cwd-");
  const env = {
    ...process.env,
    GAHAR_CONFIG_DIR: await tempDir("gahar-cli-cfg-"),
    GAHAR_BASE_URL: mock.baseUrl,
    GAHAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  delete env.OPENROUTER_API_KEY;
  if (apiKey !== null) env.OPENROUTER_API_KEY = apiKey;
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: "pipe" });
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code, stdout, stderr, cwd };
}

test("--version prints the package version", async () => {
  const { code, stdout } = await runCli(["--version"], { apiKey: null });
  assert.equal(code, 0);
  assert.ok(stdout.includes(pkg.version), stdout);
});

test("a headless prompt runs a tool call and prints the answer", async () => {
  mock.script(
    { toolCall: { id: "call_1", name: "write_file", args: { path: "out.txt", content: "hi\n" } } },
    { text: "Wrote out.txt." },
  );
  const { code, stdout, stderr, cwd } = await runCli(["--yolo", "-p", "create out.txt"]);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Wrote out\.txt\./);
  assert.equal(await readFile(join(cwd, "out.txt"), "utf8"), "hi\n");
});

test("--json emits valid JSONL events", async () => {
  mock.script({ text: "Hello from JSON." });
  const { code, stdout, stderr } = await runCli(["--json", "-p", "say hello"]);
  assert.equal(code, 0, stderr);
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  assert.ok(lines.length > 0);
  const events = lines.map((line) => JSON.parse(line));
  for (const event of events) assert.equal(typeof event.type, "string");
  const text = events
    .filter((event) => event.type === "text_delta")
    .map((event) => event.text)
    .join("");
  assert.equal(text, "Hello from JSON.");
});

test("a missing API key fails with a non-zero exit code", async () => {
  const { code, stdout, stderr } = await runCli(["-p", "hello"], { apiKey: null });
  assert.equal(code, 3);
  assert.match(`${stdout}${stderr}`, /api key/i);
});
