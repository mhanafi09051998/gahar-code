import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OpenRouterClient } from "../../../dist/api/openrouter.js";
import { readModelCache } from "../../../dist/api/models.js";

const encoder = new TextEncoder();

function sseResponse(chunks, init = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const part of chunks) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" }, ...init });
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeClient(fetchImpl, extra = {}) {
  return new OpenRouterClient({
    apiKey: "sk-or-v1-test-key-000000000000",
    baseUrl: "https://example.test/api/v1",
    fetchImpl,
    retryDelayMs: 0,
    ...extra,
  });
}

const okStream = [
  'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"cost":0.001}}\n\n',
  "data: [DONE]\n\n",
];

test("streams text and returns usage", async () => {
  const calls = [];
  const client = makeClient(async (url, init) => {
    calls.push({ url, init });
    return sseResponse(okStream);
  });
  const deltas = [];
  const result = await client.streamChat(
    { model: "test/model", messages: [{ role: "user", content: "hi" }] },
    { onText: (t) => deltas.push(t) },
  );
  assert.deepEqual(deltas, ["Hi"]);
  assert.equal(result.message.content, "Hi");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage.total_tokens, 12);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-or-v1-test-key-000000000000");
  assert.ok(calls[0].init.headers["HTTP-Referer"]);
  assert.ok(calls[0].init.headers["X-Title"]);
  assert.equal(calls[0].url, "https://example.test/api/v1/chat/completions");
});

test("sends tools and tool_choice auto when tools exist", async () => {
  let body;
  const client = makeClient(async (_url, init) => {
    body = JSON.parse(init.body);
    return sseResponse(okStream);
  });
  await client.streamChat(
    {
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { name: "t", description: "d", parameters: {} } }],
    },
    {},
  );
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.tools.length, 1);
});

test("retries on 429 then succeeds", async () => {
  let attempts = 0;
  const client = makeClient(async () => {
    attempts += 1;
    if (attempts === 1) return jsonResponse({ error: { message: "slow down" } }, 429);
    return sseResponse(okStream);
  });
  const result = await client.streamChat({ model: "m", messages: [] }, {});
  assert.equal(attempts, 2);
  assert.equal(result.message.content, "Hi");
});

test("honours Retry-After header", async () => {
  const delays = [];
  let attempts = 0;
  const client = makeClient(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse({ error: { message: "slow" } }, 429, { "retry-after": "2" });
      }
      return sseResponse(okStream);
    },
    { retryDelayMs: undefined, sleepImpl: async (ms) => delays.push(ms) },
  );
  await client.streamChat({ model: "m", messages: [] }, {});
  assert.deepEqual(delays, [2000]);
});

test("gives up after 3 attempts on 503", async () => {
  let attempts = 0;
  const client = makeClient(async () => {
    attempts += 1;
    return jsonResponse({ error: { message: "unavailable" } }, 503);
  });
  await assert.rejects(
    () => client.streamChat({ model: "m", messages: [] }, {}),
    (error) => error.code === "provider_error",
  );
  assert.equal(attempts, 3);
});

test("does not retry 401 and maps to exit code 3", async () => {
  let attempts = 0;
  const client = makeClient(async () => {
    attempts += 1;
    return jsonResponse({ error: { message: "bad key" } }, 401);
  });
  await assert.rejects(
    () => client.streamChat({ model: "m", messages: [] }, {}),
    (error) => error.exitCode === 3 && error.code === "unauthorized",
  );
  assert.equal(attempts, 1);
});

test("retries network errors", async () => {
  let attempts = 0;
  const client = makeClient(async () => {
    attempts += 1;
    if (attempts < 3) throw new TypeError("fetch failed");
    return sseResponse(okStream);
  });
  const result = await client.streamChat({ model: "m", messages: [] }, {});
  assert.equal(attempts, 3);
  assert.equal(result.message.content, "Hi");
});

test("surfaces provider error payloads mid-stream", async () => {
  const client = makeClient(async () =>
    sseResponse(['data: {"error":{"message":"mid-stream boom"}}\n\n']),
  );
  await assert.rejects(
    () => client.streamChat({ model: "m", messages: [] }, {}),
    (error) => /mid-stream boom/.test(error.message),
  );
});

test("aborting rejects promptly with AbortError", async () => {
  const controller = new AbortController();
  const client = makeClient(async (_url, init) => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
        init.signal.addEventListener("abort", () => c.error(new Error("aborted")));
      },
    });
    return new Response(body, { status: 200 });
  });
  const promise = client.streamChat({ model: "m", messages: [], signal: controller.signal }, {});
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, (error) => error.name === "AbortError");
});

test("listModels filters :batch variants and caches to disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gahar-models-"));
  try {
    let calls = 0;
    const client = makeClient(
      async () => {
        calls += 1;
        return jsonResponse({
          data: [
            { id: "a/model", context_length: 1000, pricing: { prompt: "0.000001" } },
            { id: "a/model:batch" },
          ],
        });
      },
      { configDir: dir },
    );
    const models = await client.listModels();
    assert.deepEqual(models.map((m) => m.id), ["a/model"]);
    assert.equal(models[0].context_length, 1000);
    const cached = await readModelCache(dir);
    assert.deepEqual(cached.map((m) => m.id), ["a/model"]);
    const raw = JSON.parse(await readFile(join(dir, "cache", "models.json"), "utf8"));
    assert.equal(typeof raw.fetchedAt, "number");
    await client.listModels();
    assert.equal(calls, 1, "second call served from memory");
    await client.listModels({ force: true });
    assert.equal(calls, 2, "force refresh hits the network");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateKey maps /key payload and 401 to exit code 3", async () => {
  const client = makeClient(async () =>
    jsonResponse({ data: { label: "k", limit: 10, usage: 1.5, limit_remaining: 8.5, is_free_tier: false } }),
  );
  const info = await client.validateKey("sk-or-v1-other");
  assert.equal(info.limit, 10);
  assert.equal(info.limit_remaining, 8.5);

  const bad = makeClient(async () => jsonResponse({ error: { message: "nope" } }, 401));
  await assert.rejects(
    () => bad.validateKey("sk-or-v1-bad"),
    (error) => error.exitCode === 3,
  );
});
