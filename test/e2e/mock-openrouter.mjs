import { createServer } from "node:http";

export const GOOD_KEY = "sk-or-v1-test-e2e-good";
export const BAD_KEY = "sk-or-v1-test-e2e-bad";

const USAGE = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, cost: 0.0001 };

function sse(res, payloads) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(": OPENROUTER PROCESSING\n\n");
  for (const payload of payloads) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.end("data: [DONE]\n\n");
}

function textChunks(text) {
  const half = Math.ceil(text.length / 2);
  return [
    { choices: [{ delta: { role: "assistant", content: text.slice(0, half) } }] },
    { choices: [{ delta: { content: text.slice(half) } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: USAGE },
  ];
}

/** Splits the tool call arguments across deltas, like OpenRouter streams them. */
function toolCallChunks({ id, name, args }) {
  const json = JSON.stringify(args);
  const half = Math.ceil(json.length / 2);
  const delta = (fn, extra = {}) => ({
    choices: [{ delta: { tool_calls: [{ index: 0, ...extra, function: fn }] } }],
  });
  return [
    delta({ name, arguments: "" }, { id, type: "function" }),
    delta({ arguments: json.slice(0, half) }),
    delta({ arguments: json.slice(half) }),
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: USAGE },
  ];
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

/**
 * Local stand-in for https://openrouter.ai/api/v1. Each chat request consumes the next
 * scripted reply, either { text } or { toolCall: { id, name, args } }. Requests are recorded.
 */
export async function startMockOpenRouter() {
  const replies = [];
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) {
      sendJson(res, 401, { error: { message: "No auth credentials found", code: 401 } });
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/models") {
      sendJson(res, 200, { data: [] });
      return;
    }
    if (req.method !== "POST" || req.url !== "/api/v1/chat/completions") {
      sendJson(res, 404, { error: { message: `unexpected ${req.method} ${req.url}` } });
      return;
    }
    requests.push(JSON.parse(await readBody(req)));
    const reply = replies.shift() ?? { text: "(no scripted reply)" };
    sse(res, reply.toolCall ? toolCallChunks(reply.toolCall) : textChunks(reply.text));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    requests,
    script: (...items) => replies.push(...items),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
