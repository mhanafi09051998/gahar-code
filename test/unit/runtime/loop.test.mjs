import assert from "node:assert/strict";
import { test } from "node:test";
import { ABORTED_BY_USER_RESULT, runTurn, toolDefinitions } from "../../../dist/agent/loop.js";

function fakeClient(script) {
  const requests = [];
  return {
    requests,
    async streamChat(request, handlers) {
      requests.push(request);
      const step = script[requests.length - 1];
      if (!step) throw new Error("unexpected extra model call");
      return step(request, handlers);
    },
    async listModels() {
      return [];
    },
    async validateKey() {
      return {};
    },
  };
}

const say = (text, usage) => (_req, handlers) => {
  handlers.onText?.(text);
  return { message: { role: "assistant", content: text }, finishReason: "stop", usage };
};

const callTools =
  (...calls) =>
  () => ({
    message: {
      role: "assistant",
      content: null,
      tool_calls: calls.map(([id, name, args]) => ({
        id,
        type: "function",
        function: { name, arguments: args },
      })),
    },
    finishReason: "tool_calls",
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.002 },
  });

function registry(tools) {
  return {
    list: () => tools,
    get: (name) => tools.find((tool) => tool.name === name),
    definitions: () => toolDefinitions(tools),
  };
}

function makeTool(name, readOnly, run) {
  return { name, description: name, parameters: { type: "object" }, readOnly, execute: run };
}

function deps(client, tools, extra = {}) {
  const events = [];
  const saved = [];
  return {
    events,
    saved,
    deps: {
      client,
      tools: registry(tools),
      session: { appendMessage: async (m) => saved.push(m) },
      config: { model: "test/model", maxTokens: 1000 },
      emit: (event) => events.push(event),
      buildToolContext: (signal) => ({ signal }),
      systemPrompt: "SYS",
      ...extra,
    },
  };
}

const echo = makeTool("echo", true, async (args) => ({ ok: true, output: `echo:${args.text}` }));

test("tool call followed by a final answer", async () => {
  const client = fakeClient([
    callTools(["c1", "echo", '{"text":"hi"}']),
    say("All done", { prompt_tokens: 50, completion_tokens: 5, cost: 0.001 }),
  ]);
  const { deps: d, events, saved } = deps(client, [echo]);
  const result = await runTurn(d, "please echo", new AbortController().signal);
  assert.equal(result.text, "All done");
  assert.equal(result.iterations, 2);
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(
    saved.map((m) => m.role),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.equal(saved[2].content, "echo:hi");
  assert.equal(saved[2].tool_call_id, "c1");
  const second = client.requests[1];
  assert.equal(second.messages[0].content, "SYS");
  assert.equal(second.tool_choice, "auto");
  assert.equal(second.messages.at(-1).role, "tool");
  const types = events.map((e) => e.type);
  assert.ok(types.includes("tool_use") && types.includes("tool_result"));
  assert.equal(types.filter((t) => t === "usage").length, 2);
  assert.equal(result.usage.prompt_tokens, 150);
  assert.ok(Math.abs(result.usage.cost - 0.003) < 1e-12);
});

test("unknown tools and broken JSON arguments become error results", async () => {
  const client = fakeClient([
    callTools(["u1", "nope", "{}"], ["b1", "echo", "{bad json"]),
    say("recovered"),
  ]);
  const { deps: d, events, saved } = deps(client, [echo]);
  const result = await runTurn(d, "x", new AbortController().signal);
  assert.equal(result.text, "recovered");
  const toolMessages = saved.filter((m) => m.role === "tool");
  assert.match(toolMessages[0].content, /Unknown tool: nope/);
  assert.match(toolMessages[1].content, /Invalid JSON arguments for echo/);
  const results = events.filter((e) => e.type === "tool_result");
  assert.deepEqual(
    results.map((e) => e.ok),
    [false, false],
  );
  assert.equal(events.filter((e) => e.type === "tool_use").length, 2);
});

test("throwing tools are reported, not thrown", async () => {
  const boom = makeTool("boom", false, async () => {
    throw new Error("kaput");
  });
  const client = fakeClient([callTools(["x1", "boom", "{}"]), say("ok")]);
  const { deps: d, saved } = deps(client, [boom]);
  await runTurn(d, "x", new AbortController().signal);
  assert.match(saved[2].content, /Tool boom failed: kaput/);
});

test("read-only tools run concurrently and mutating tools sequentially", async () => {
  let active = 0;
  let peak = 0;
  const slow = makeTool("slow", true, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return { ok: true, output: "r" };
  });
  const order = [];
  const write = makeTool("write", false, async (args) => {
    order.push(args.n);
    return { ok: true, output: "w" };
  });
  const calls = [];
  for (let i = 0; i < 6; i++) calls.push([`r${i}`, "slow", "{}"]);
  calls.push(["w1", "write", '{"n":1}'], ["w2", "write", '{"n":2}']);
  const client = fakeClient([callTools(...calls), say("fin")]);
  const { deps: d, saved } = deps(client, [slow, write]);
  await runTurn(d, "x", new AbortController().signal);
  assert.equal(peak, 4);
  assert.deepEqual(order, [1, 2]);
  const ids = saved.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  assert.deepEqual(ids, ["r0", "r1", "r2", "r3", "r4", "r5", "w1", "w2"]);
});

test("abort during a tool keeps the history valid and rethrows AbortError", async () => {
  const controller = new AbortController();
  const hang = makeTool("hang", false, async (_args, ctx) => {
    controller.abort();
    const error = new Error("stopped");
    error.name = "AbortError";
    if (ctx.signal.aborted) throw error;
    return { ok: true, output: "never" };
  });
  const client = fakeClient([callTools(["h1", "hang", "{}"])]);
  const { deps: d, events, saved } = deps(client, [hang]);
  await assert.rejects(runTurn(d, "x", controller.signal), (e) => e.name === "AbortError");
  assert.deepEqual(
    saved.map((m) => m.role),
    ["user", "assistant", "tool"],
  );
  assert.equal(saved[2].content, ABORTED_BY_USER_RESULT);
  assert.ok(events.some((e) => e.type === "notice" && /aborted/.test(e.message)));
});

test("stops at the iteration limit with a notice", async () => {
  const loop = () => callTools(["l", "echo", '{"text":"again"}'])();
  const client = fakeClient([loop, loop, loop]);
  const { deps: d, events } = deps(client, [echo], { maxIterations: 3 });
  const result = await runTurn(d, "x", new AbortController().signal);
  assert.equal(result.iterations, 3);
  assert.equal(client.requests.length, 3);
  assert.ok(events.some((e) => e.type === "notice" && /maximum of 3/.test(e.message)));
  assert.equal(result.finishReason, "max_iterations");
});

test("a read after an edit in the same batch runs after the edit", async () => {
  const order = [];
  const logged = (name) => async () => {
    order.push(name);
    return { ok: true, output: name };
  };
  const read = makeTool("read", true, logged("read"));
  const edit = makeTool("edit", false, logged("edit"));
  const client = fakeClient([callTools(["e1", "edit", "{}"], ["r1", "read", "{}"]), say("ok")]);
  const { deps: d } = deps(client, [read, edit]);
  await runTurn(d, "x", new AbortController().signal);
  assert.deepEqual(order, ["edit", "read"]);
});

test("abort keeps the real results of calls that already finished", async () => {
  const controller = new AbortController();
  const write = makeTool("write", false, async () => ({ ok: true, output: "wrote x" }));
  const hang = makeTool("hang", false, async () => {
    controller.abort();
    const error = new Error("stopped");
    error.name = "AbortError";
    throw error;
  });
  const client = fakeClient([
    callTools(["w1", "write", "{}"], ["h1", "hang", "{}"], ["n1", "write", "{}"]),
  ]);
  const { deps: d, saved } = deps(client, [write, hang]);
  await assert.rejects(runTurn(d, "x", controller.signal), (e) => e.name === "AbortError");
  const results = saved.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m.content]);
  assert.deepEqual(results, [
    ["w1", "wrote x"],
    ["h1", ABORTED_BY_USER_RESULT],
    ["n1", ABORTED_BY_USER_RESULT],
  ]);
});

test("history is sent after the system prompt and estimated cost uses model pricing", async () => {
  const client = fakeClient([say("hi", { prompt_tokens: 1000, completion_tokens: 100 })]);
  const history = [
    { role: "user", content: "earlier" },
    { role: "assistant", content: "reply" },
  ];
  const modelInfo = { id: "m", pricing: { prompt: "0.000001", completion: "0.00001" } };
  const { deps: d } = deps(client, [], { history, modelInfo });
  const result = await runTurn(d, "now", new AbortController().signal);
  assert.deepEqual(
    client.requests[0].messages.map((m) => m.content),
    ["SYS", "earlier", "reply", "now"],
  );
  assert.equal(client.requests[0].tools, undefined);
  assert.ok(Math.abs(result.usage.cost - 0.002) < 1e-12);
  assert.equal(result.totals.estimated, true);
});
