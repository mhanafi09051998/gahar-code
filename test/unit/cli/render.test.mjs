import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createApprovalHandler, parseAnswer } from "../../../dist/ui/approval.js";
import { createBanner, shortenPath } from "../../../dist/ui/banner.js";
import {
  historyPath,
  loadHistory,
  MAX_HISTORY,
  pushHistory,
  saveHistory,
} from "../../../dist/ui/prompt.js";
import {
  formatCost,
  Renderer,
  summarizeToolOutput,
  truncateLine,
} from "../../../dist/ui/render.js";
import { formatUpdateLine, notifyUpdate } from "../../../dist/ui/update-notifier.js";

const dirs = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "gahar-cli-"));
  dirs.push(dir);
  return dir;
}
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function sink() {
  const chunks = [];
  return { write: (chunk) => chunks.push(chunk), text: () => chunks.join("") };
}

const request = {
  tool: "write_file",
  action: "write",
  title: "Write src/a.ts",
  resource: "src/a.ts",
  detail: "+added\n-removed",
};

test("renderer without color prints plain tool lines and collapsed results", () => {
  const err = sink();
  const renderer = new Renderer({ stderr: err, color: false, json: false, columns: 80 });
  renderer.toolUse("read_file", { path: "src/app.ts" });
  renderer.toolResult("read_file", true, "l1\nl2\nl3\nl4\nl5\n");
  renderer.diff("--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new");
  renderer.error("boom", "try again");
  renderer.usageLine({ total: 42, cost: 0.0123, elapsedMs: 1500 });
  const out = err.text();
  assert.match(out, /-> read_file \{"path":"src\/app.ts"\}/);
  assert.match(out, /\| l3\n/);
  assert.doesNotMatch(out, /\| l4/);
  assert.match(out, /\.\.\. 2 more lines/);
  assert.match(out, /^-old$/m);
  assert.match(out, /^\+new$/m);
  assert.match(out, /error: boom\n {2}try again/);
  assert.match(out, /42 tokens · \$0\.0123 · 1\.5s/);
  assert.equal(out.includes("\u001b["), false, "no ANSI escapes without color");
});

test("renderer streams text after the spinner and keeps line state", () => {
  const err = sink();
  const renderer = new Renderer({ stderr: err, color: false, json: false });
  renderer.spinnerStart();
  renderer.text("hello ");
  renderer.text("world");
  renderer.line("next");
  renderer.spinnerStop();
  assert.equal(err.text(), "| hello world\nnext\n");
});

test("render helpers", () => {
  assert.equal(formatCost(0), "$0.0000");
  assert.equal(formatCost(0.00001), "<$0.0001");
  assert.equal(formatCost(1.5), "$1.5000");
  assert.equal(truncateLine("abcdefghij", 6), "abc...");
  assert.equal(summarizeToolOutput("a\nb\nc\nd", 2), "a\nb\n... 2 more lines");
  assert.equal(summarizeToolOutput("a\nb", 3), "a\nb");
});

test("approval answers default to deny", () => {
  assert.equal(parseAnswer("y"), "allow");
  assert.equal(parseAnswer("YES"), "allow");
  assert.equal(parseAnswer("a"), "allow-session");
  assert.equal(parseAnswer(""), "deny");
  assert.equal(parseAnswer("nope"), "deny");
});

test("approval handler denies silently when non-interactive or json", async () => {
  for (const options of [{ interactive: false }, { interactive: true, json: true }]) {
    const err = sink();
    let asked = false;
    const handler = createApprovalHandler({
      stderr: err,
      ...options,
      ask: async () => {
        asked = true;
        return "y";
      },
    });
    assert.equal(await handler.request(request), "deny");
    assert.equal(asked, false);
    assert.equal(err.text(), "");
  }
});

test("approval handler prompts, remembers 'always' and never throws", async () => {
  const err = sink();
  const answers = ["a", "boom"];
  const handler = createApprovalHandler({
    stderr: err,
    interactive: true,
    ask: async () => {
      const next = answers.shift();
      if (next === "boom") throw new Error("tty gone");
      return next;
    },
  });
  assert.equal(await handler.request(request), "allow-session");
  assert.equal(await handler.request(request), "allow-session");
  assert.match(err.text(), /Write src\/a.ts \(write\)/);
  assert.match(err.text(), /\+added/);
  assert.equal(await handler.request({ ...request, resource: "other" }), "deny");
});

test("approval handler resolves deny when the turn is aborted mid-prompt", async () => {
  const controller = new AbortController();
  const handler = createApprovalHandler({
    stderr: sink(),
    interactive: true,
    ask: () => new Promise(() => {}),
  });
  const pending = handler.request(request, controller.signal);
  controller.abort();
  assert.equal(await pending, "deny");
});

test("prompt history persists newest-first and caps at 200 entries", async () => {
  const dir = await tempDir();
  assert.deepEqual(await loadHistory(dir), []);
  let history = [];
  for (let i = 0; i < MAX_HISTORY + 5; i += 1) history = pushHistory(history, `cmd ${i}`);
  history = pushHistory(history, "cmd 203");
  history = pushHistory(history, "multi\nline");
  assert.equal(history.length, MAX_HISTORY);
  assert.equal(history[0], "multi line");
  assert.equal(history[1], "cmd 203");
  await saveHistory(dir, history);
  const raw = await readFile(historyPath(dir), "utf8");
  assert.equal(raw.trim().split("\n").length, MAX_HISTORY);
  assert.deepEqual(await loadHistory(dir), history);
});

test("banner shows version, model and a shortened cwd", () => {
  const lines = createBanner({
    version: "9.9.9",
    model: "x/y",
    cwd: "/very/long/path/to/project",
    permissionMode: "ask",
    sessionId: "s1",
    resumed: true,
    columns: 40,
  });
  assert.equal(lines[0], "Gahar Code 9.9.9");
  assert.ok(lines.some((line) => line.includes("x/y")));
  assert.ok(lines.some((line) => line.includes("s1 (resumed)")));
  assert.equal(shortenPath("/a/b", 20), "/a/b");
  assert.ok(shortenPath("/aaaa/bbbb/cccc/dddd", 12).length <= 12);
});

test("update notifier prints once per 24h and swallows failures", async () => {
  const dir = await tempDir();
  const err = sink();
  let calls = 0;
  const base = {
    stderr: err,
    configDir: dir,
    enabled: true,
    env: {},
    now: () => 1_000_000,
    check: async () => {
      calls += 1;
      return { latestVersion: "0.2.0", updateAvailable: true };
    },
  };
  const first = await notifyUpdate(base);
  assert.equal(first.printed, true);
  assert.equal(err.text(), `${formatUpdateLine("0.2.0")}\n`);
  assert.equal(formatUpdateLine("0.2.0"), "Update available: 0.2.0 -> run: gahar update");
  assert.equal((await notifyUpdate(base)).printed, false);
  assert.equal(calls, 1);
  const later = await notifyUpdate({ ...base, now: () => 1_000_000 + 25 * 3600 * 1000 });
  assert.equal(later.printed, true);

  const failing = await notifyUpdate({
    ...base,
    configDir: await tempDir(),
    check: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(failing.printed, false);
  const disabled = await notifyUpdate({ ...base, env: { GAHAR_NO_UPDATE_CHECK: "1" } });
  assert.equal(disabled.checked, false);
  await writeFile(join(dir, "cache", "update-notify.json"), "{corrupt", "utf8");
  assert.equal((await notifyUpdate(base)).printed, true);
});

test("update notifier never waits longer than its timeout", async () => {
  const started = Date.now();
  const result = await notifyUpdate({
    stderr: sink(),
    configDir: await tempDir(),
    enabled: true,
    env: {},
    timeoutMs: 50,
    check: () => new Promise(() => {}),
  });
  assert.equal(result.printed, false);
  assert.ok(Date.now() - started < 1000);
});
