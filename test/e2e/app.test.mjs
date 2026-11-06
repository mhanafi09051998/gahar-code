import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../../dist/app.js";
import { BAD_KEY, GOOD_KEY, startMockOpenRouter } from "./mock-openrouter.mjs";

let mock;
const cleanup = [];

before(async () => {
  mock = await startMockOpenRouter();
});

after(async () => {
  await mock.close();
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

async function workspace() {
  return { cwd: await tempDir("gahar-e2e-cwd-"), configDir: await tempDir("gahar-e2e-cfg-") };
}

function makeConfig({ cwd, configDir }, overrides = {}) {
  return {
    cwd,
    configDir,
    apiKey: GOOD_KEY,
    apiKeySource: "env",
    model: "test/model",
    maxTokens: 1000,
    permissionMode: "auto-edit",
    updateCheck: false,
    contextCompaction: true,
    showReasoning: false,
    baseUrl: mock.baseUrl,
    debug: false,
    noColor: true,
    warnings: [],
    ...overrides,
  };
}

async function open(ws, extra = {}) {
  const events = [];
  const { config: overrides, ...rest } = extra;
  const app = await createApp({
    cwd: ws.cwd,
    config: makeConfig(ws, overrides),
    approvals: { request: async () => "deny" },
    events: (event) => events.push(event),
    ...rest,
  });
  return { app, events };
}

const signal = () => new AbortController().signal;

const writeCall = {
  toolCall: {
    id: "call_write_1",
    name: "write_file",
    args: { path: "hello.txt", content: "hello from gahar\n" },
  },
};

test("a turn with a write_file tool call changes the workspace and can be undone", async () => {
  const ws = await workspace();
  const { app, events } = await open(ws);
  mock.script(writeCall, { text: "Created hello.txt." });
  const start = mock.requests.length;

  const result = await app.runTurn("create hello.txt", signal());

  assert.equal(result.text, "Created hello.txt.");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage.total_tokens, 50);
  assert.equal(await readFile(join(ws.cwd, "hello.txt"), "utf8"), "hello from gahar\n");
  const toolResult = events.find((event) => event.type === "tool_result");
  assert.equal(toolResult?.ok, true, toolResult?.output);
  const followUp = mock.requests[start + 1];
  const toolMessage = followUp.messages.find((message) => message.role === "tool");
  assert.equal(toolMessage.tool_call_id, "call_write_1");
  assert.ok(followUp.tools.some((tool) => tool.function.name === "write_file"));
  assert.equal(app.getUsage().total_tokens, 50);

  assert.equal(await app.undo(), true);
  await assert.rejects(readFile(join(ws.cwd, "hello.txt"), "utf8"), { code: "ENOENT" });
  assert.equal(await app.undo(), false);
  await app.close();
});

test("ask mode with a denying approval handler blocks the write", async () => {
  const ws = await workspace();
  const { app, events } = await open(ws, { config: { permissionMode: "ask" } });
  mock.script(writeCall, { text: "Could not write." });

  await app.runTurn("create hello.txt", signal());

  await assert.rejects(readFile(join(ws.cwd, "hello.txt"), "utf8"), { code: "ENOENT" });
  const approval = events.find((event) => event.type === "approval");
  assert.equal(approval?.decision, "deny");
  const toolResult = events.find((event) => event.type === "tool_result");
  assert.equal(toolResult?.ok, false);
  assert.match(toolResult?.output ?? "", /permission denied/i);
  await app.close();
});

test("resuming a session sends the earlier conversation again", async () => {
  const ws = await workspace();
  const first = await open(ws);
  mock.script({ text: "Remembered." });
  await first.app.runTurn("remember the word kiwi", signal());
  const sessionId = first.app.sessionId;
  await first.app.close();

  for (const resume of [{ type: "id", id: sessionId }, { type: "latest" }]) {
    const second = await open(ws, { resume });
    assert.equal(second.app.sessionId, sessionId);
    mock.script({ text: "kiwi" });
    const result = await second.app.runTurn("what was the word?", signal());
    assert.equal(result.text, "kiwi");
    const sent = mock.requests.at(-1).messages.map((message) => message.content);
    assert.ok(sent.includes("remember the word kiwi"));
    assert.ok(sent.includes("Remembered."));
    await second.app.close();
  }

  await assert.rejects(open(ws, { resume: { type: "id", id: "../escape" } }), {
    code: "session_not_found",
  });
});

test("a rejected API key fails the turn with an auth error (exit code 3)", async () => {
  const ws = await workspace();
  const { app } = await open(ws, { config: { apiKey: BAD_KEY } });
  await assert.rejects(app.runTurn("hi", signal()), (error) => {
    assert.equal(error.exitCode, 3);
    assert.equal(error.code, "unauthorized");
    assert.ok(!String(error.message).includes(BAD_KEY));
    return true;
  });
  await app.close();
});

test("a missing API key is rejected before any request", async () => {
  const ws = await workspace();
  await assert.rejects(open(ws, { config: { apiKey: null, apiKeySource: "none" } }), {
    code: "missing_api_key",
    exitCode: 3,
  });
});
