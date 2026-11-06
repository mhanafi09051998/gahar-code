import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenRouterClient } from "../../../dist/api/openrouter.js";

const encoder = new TextEncoder();

function sseResponse(chunks, { hang = false } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const part of chunks) controller.enqueue(encoder.encode(part));
      if (!hang) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const okStream = [
  'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
];

function scripted(responses, extra = {}) {
  let attempts = 0;
  const client = new OpenRouterClient({
    apiKey: "sk-or-v1-test-key-000000000000",
    baseUrl: "https://example.test/api/v1",
    retryDelayMs: 0,
    fetchImpl: async () => responses[Math.min(attempts++, responses.length - 1)](),
    ...extra,
  });
  return { client, attempts: () => attempts };
}

const chat = (client, signal) => client.streamChat({ model: "m", messages: [], signal }, {});

test("a stream cut off after output is an error, not a short answer", async () => {
  const { client, attempts } = scripted([() => sseResponse([okStream[0]])]);
  await assert.rejects(chat(client), /ended before the response was complete/);
  assert.equal(attempts(), 1);
});

test("a body of only keep-alive comments is retried", async () => {
  const { client, attempts } = scripted([
    () => sseResponse([": OPENROUTER PROCESSING\n\n"]),
    () => sseResponse(okStream),
  ]);
  const result = await chat(client);
  assert.equal(result.message.content, "Hi");
  assert.equal(attempts(), 2);
});

test("a completed stream with no content and no tool calls is empty_response", async () => {
  const { client, attempts } = scripted([() => sseResponse(okStream.slice(1))], {
    maxRetries: 2,
  });
  await assert.rejects(chat(client), (error) => error.code === "empty_response");
  assert.equal(attempts(), 2);
});

test("a stalled stream times out as a retryable network error", async () => {
  const { client, attempts } = scripted(
    [
      () => sseResponse([": OPENROUTER PROCESSING\n\n"], { hang: true }),
      () => sseResponse(okStream),
    ],
    { idleTimeoutMs: 50 },
  );
  const result = await chat(client, new AbortController().signal);
  assert.equal(result.message.content, "Hi");
  assert.equal(attempts(), 2);
  const stalled = scripted([() => sseResponse([], { hang: true })], {
    idleTimeoutMs: 30,
    maxRetries: 1,
  });
  await assert.rejects(chat(stalled.client), (error) => error.code === "network_error");
});
