import assert from "node:assert/strict";
import { test } from "node:test";
import { SseParser, applySsePayload, readSseStream } from "../../../dist/api/sse.js";

function newAcc() {
  return {
    content: "",
    reasoning: "",
    toolCalls: [],
    finishReason: null,
    usage: undefined,
    model: undefined,
    generationId: undefined,
    error: undefined,
  };
}

function chunk(text) {
  return new TextEncoder().encode(text);
}

function streamOf(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const part of chunks) controller.enqueue(chunk(part));
      controller.close();
    },
  });
}

test("parses a simple data event", () => {
  const parser = new SseParser();
  const events = parser.push('data: {"a":1}\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].data, '{"a":1}');
});

test("handles CRLF line endings", () => {
  const parser = new SseParser();
  const events = parser.push('data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n');
  assert.deepEqual(events.map((e) => e.data), ['{"a":1}', '{"b":2}']);
});

test("ignores comment lines and joins multi-line data", () => {
  const parser = new SseParser();
  const events = parser.push(": keep-alive\ndata: line1\ndata: line2\n\n");
  assert.equal(events.length, 1);
  assert.equal(events[0].data, "line1\nline2");
});

test("survives chunk boundaries splitting any line", () => {
  const parser = new SseParser();
  const out = [];
  for (const part of ["da", "ta: {\"x\"", ":1}\n", "\n"]) out.push(...parser.push(part));
  assert.equal(out.length, 1);
  assert.equal(out[0].data, '{"x":1}');
});

test("readSseStream yields payloads across arbitrary chunk splits", async () => {
  const body = streamOf(['data: {"a"', ":1}\n\n", "data: [DONE]\n\n"]);
  const seen = [];
  for await (const payload of readSseStream(body)) seen.push(payload);
  assert.deepEqual(seen, ['{"a":1}', "[DONE]"]);
});

test("accumulates content deltas", () => {
  const acc = newAcc();
  applySsePayload(acc, JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }));
  applySsePayload(acc, JSON.stringify({ choices: [{ delta: { content: "lo" } }] }));
  assert.equal(acc.content, "Hello");
});

test("accumulates reasoning and reasoning_details", () => {
  const acc = newAcc();
  applySsePayload(acc, JSON.stringify({ choices: [{ delta: { reasoning: "think " } }] }));
  applySsePayload(
    acc,
    JSON.stringify({ choices: [{ delta: { reasoning_details: [{ type: "text", text: "more" }] } }] }),
  );
  assert.equal(acc.reasoning, "think more");
});

test("accumulates incremental tool calls by index", () => {
  const acc = newAcc();
  applySsePayload(
    acc,
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"pa' } },
            ],
          },
        },
      ],
    }),
  );
  applySsePayload(
    acc,
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }],
    }),
  );
  applySsePayload(
    acc,
    JSON.stringify({
      choices: [
        { delta: { tool_calls: [{ index: 1, id: "call_2", function: { name: "list_dir" } }] } },
      ],
    }),
  );
  assert.equal(acc.toolCalls.length, 2);
  assert.equal(acc.toolCalls[0].id, "call_1");
  assert.equal(acc.toolCalls[0].function.name, "read_file");
  assert.equal(acc.toolCalls[0].function.arguments, '{"path":"a.ts"}');
  assert.equal(acc.toolCalls[1].function.name, "list_dir");
});

test("captures usage-only final chunk and finish reason", () => {
  const acc = newAcc();
  applySsePayload(
    acc,
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 5 } }),
  );
  applySsePayload(acc, JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
  assert.equal(acc.finishReason, "stop");
  assert.equal(acc.usage.total_tokens, 5);
});

test("skips malformed JSON chunks without throwing", () => {
  const acc = newAcc();
  assert.doesNotThrow(() => applySsePayload(acc, "{not json"));
  assert.doesNotThrow(() => applySsePayload(acc, ""));
  assert.equal(acc.content, "");
});

test("records provider error payloads", () => {
  const acc = newAcc();
  applySsePayload(acc, JSON.stringify({ error: { message: "provider exploded", code: 502 } }));
  assert.equal(acc.error.message, "provider exploded");
});

test("[DONE] is recognised", () => {
  const acc = newAcc();
  applySsePayload(acc, "[DONE]");
  assert.equal(acc.content, "");
  assert.equal(acc.error, undefined);
});
