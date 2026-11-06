import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  ABORTED_TOOL_RESULT,
  latestSessionId,
  listSessions,
  removeSession,
  SessionStore,
  sessionExists,
} from "../../../dist/session/store.js";
import { deriveTitle } from "../../../dist/session/title.js";

const roots = [];
after(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

async function freshDirs() {
  const root = await mkdtemp(join(tmpdir(), "gahar-session-"));
  roots.push(root);
  return { configDir: join(root, "home"), cwd: join(root, "proj") };
}

const toolCall = (id, name = "read_file") => ({
  id,
  type: "function",
  function: { name, arguments: "{}" },
});

test("deriveTitle uses the first non-empty line, trimmed to 60 chars", () => {
  assert.equal(deriveTitle("\n  Fix the login bug  \nmore"), "Fix the login bug");
  assert.equal(deriveTitle("   "), "New session");
  const long = deriveTitle("word ".repeat(40));
  assert.ok(long.length <= 60);
  assert.ok(long.endsWith("…"));
});

test("create, append, reload and resume a session", async () => {
  const { configDir, cwd } = await freshDirs();
  const store = await SessionStore.create({ configDir, cwd, model: "m/1" });
  assert.match(store.dir, /projects[\\/]proj-[0-9a-f]{8}[\\/]sessions[\\/]/);
  await store.appendMessage({ role: "user", content: "Refactor the parser\nplease" });
  await store.appendMessage({ role: "assistant", content: "Done." });
  await store.appendUsage({
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    cost: 0.01,
  });

  const meta = JSON.parse(await readFile(join(store.dir, "meta.json"), "utf8"));
  assert.equal(meta.title, "Refactor the parser");
  assert.equal(meta.messageCount, 2);

  const loaded = await SessionStore.load(configDir, cwd, store.id);
  assert.equal(loaded.getMeta().title, "Refactor the parser");
  const messages = await loaded.readMessages();
  assert.deepEqual(
    messages.map((m) => m.content),
    ["Refactor the parser\nplease", "Done."],
  );
  assert.equal((await loaded.readUsage()).total_tokens, 15);
  await loaded.appendMessage({ role: "user", content: "Second question" });
  assert.equal(loaded.getMeta().title, "Refactor the parser", "title is set once");
  assert.equal((await loaded.readMessages()).length, 3);
  assert.equal(await SessionStore.load(configDir, cwd, "missing"), null);
});

test("dangling tool calls are repaired with an aborted result on load", async () => {
  const { configDir, cwd } = await freshDirs();
  const store = await SessionStore.create({ configDir, cwd, model: "m" });
  await store.appendMessage({ role: "user", content: "go" });
  await store.appendMessage({
    role: "assistant",
    content: null,
    tool_calls: [toolCall("a"), toolCall("b")],
  });
  await store.appendMessage({ role: "tool", content: "ok", tool_call_id: "a", name: "read_file" });
  await appendFile(store.eventsPath, "{broken json line\n");

  const messages = await store.readMessages();
  assert.equal(messages.length, 4);
  const synthetic = messages[3];
  assert.equal(synthetic.role, "tool");
  assert.equal(synthetic.tool_call_id, "b");
  assert.equal(synthetic.content, ABORTED_TOOL_RESULT);
  assert.match(ABORTED_TOOL_RESULT, /aborted by crash/);

  await store.appendMessage({ role: "user", content: "next" });
  const resumed = await store.readMessages();
  assert.deepEqual(
    resumed.map((m) => m.role),
    ["user", "assistant", "tool", "tool", "user"],
  );
});

test("list, latest and remove sessions", async () => {
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
  const { configDir, cwd } = await freshDirs();
  assert.deepEqual(await listSessions(configDir, cwd), []);
  const first = await SessionStore.create({ configDir, cwd, model: "m", now });
  const second = await SessionStore.create({ configDir, cwd, model: "m", now });
  await second.appendUsage({ total_tokens: 3 });
  const list = await listSessions(configDir, cwd);
  assert.deepEqual(
    list.map((s) => s.id),
    [second.id, first.id],
  );
  assert.equal(list[0].usage.total_tokens, 3);
  assert.equal(await latestSessionId(configDir, cwd), second.id);
  await removeSession(configDir, cwd, second.id);
  assert.equal(await sessionExists(configDir, cwd, second.id), false);
  assert.equal(await latestSessionId(configDir, cwd), first.id);
});
