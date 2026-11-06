import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compact, needsCompaction } from "../../../dist/agent/compaction.js";
import {
  buildSystemPrompt,
  buildSystemPromptWithInstructions,
  renderInstructions,
} from "../../../dist/agent/prompt.js";
import {
  accumulate,
  emptyTotals,
  formatCost,
  formatUsageSummary,
  toUsage,
} from "../../../dist/agent/usage.js";

test("usage aggregates tokens and prefers provider cost over estimates", () => {
  const model = { id: "m", pricing: { prompt: "0.000002", completion: "0.00001" } };
  const totals = emptyTotals();
  accumulate(
    totals,
    { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.5 },
    { model },
  );
  accumulate(totals, { prompt_tokens: 1000, completion_tokens: 100 }, { model });
  accumulate(totals, undefined, { model });
  assert.equal(totals.promptTokens, 1100);
  assert.equal(totals.completionTokens, 110);
  assert.equal(totals.totalTokens, 1210);
  assert.equal(totals.requests, 2);
  assert.ok(Math.abs(totals.costUsd - 0.503) < 1e-12);
  assert.equal(totals.estimated, true);
  assert.equal(toUsage(totals).total_tokens, 1210);
  assert.match(formatUsageSummary(totals), /\(estimated\)/);
});

test("formatCost renders dollars", () => {
  assert.equal(formatCost(0.0123), "$0.0123");
  assert.equal(formatCost(0), "$0.0000");
  assert.equal(formatCost(0.00001), "<$0.0001");
  assert.equal(formatCost(12.345), "$12.35");
});

const big = (n) => "x".repeat(n);

test("needsCompaction triggers above 80% of the usable window", () => {
  const model = { id: "m", context_length: 10000 };
  const small = [{ role: "user", content: big(4000) }];
  const large = [{ role: "user", content: big(26000) }];
  assert.equal(needsCompaction(small, model, 2000), false);
  assert.equal(needsCompaction(large, model, 2000), true);
});

function history() {
  return [
    { role: "system", content: "SYS" },
    { role: "user", content: "first goal" },
    { role: "assistant", content: "ack" },
    { role: "user", content: "second" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "t1", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    },
    { role: "tool", content: "file body", tool_call_id: "t1", name: "read_file" },
    { role: "tool", content: "file body 2", tool_call_id: "t1", name: "read_file" },
    { role: "assistant", content: "done" },
    { role: "user", content: "latest" },
  ];
}

test("compact keeps system, a summary block and an API-valid recent tail", async () => {
  const seen = [];
  const client = {
    async streamChat(request) {
      seen.push(request);
      return { message: { role: "assistant", content: "SUMMARY" }, finishReason: "stop" };
    },
  };
  const result = await compact(client, history(), "m/x");
  assert.equal(result.compacted, true);
  assert.equal(seen[0].model, "m/x");
  assert.match(seen[0].messages[1].content, /first goal/);
  assert.equal(result.messages[0].content, "SYS");
  assert.match(result.messages[1].content, /SUMMARY/);
  const tail = result.messages.slice(2);
  assert.equal(tail[0].role, "assistant");
  assert.ok(tail[0].tool_calls, "tail starts at the assistant that owns the tool results");
  assert.equal(result.messagesAfter, result.messages.length);
});

test("compact returns the original history on failure", async () => {
  const original = history();
  const failing = {
    async streamChat() {
      throw new Error("model down");
    },
  };
  const result = await compact(failing, original, "m");
  assert.equal(result.compacted, false);
  assert.equal(result.messages, original);
  assert.equal(result.error, "model down");
  const empty = {
    async streamChat() {
      return { message: { content: "  " } };
    },
  };
  assert.equal((await compact(empty, original, "m")).messages, original);
});

test("system prompt states identity, rules and environment facts", () => {
  const prompt = buildSystemPrompt({
    cwd: "/work/app",
    configDir: "/home/u/.gahar",
    model: "m/x",
    permissionMode: "ask",
    platform: "linux",
    shell: "bash",
    date: new Date("2026-01-02T03:04:05Z"),
  });
  for (const fragment of [
    "Gahar Code",
    "Never fabricate",
    "untrusted",
    "absolute",
    "/work/app",
    "2026-01-02",
    "bash",
  ]) {
    assert.ok(prompt.includes(fragment), fragment);
  }
});

test("project instructions are loaded, truncated and capped", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gahar-prompt-"));
  try {
    await writeFile(join(cwd, "AGENTS.md"), `HEAD-MARK ${big(20000)} TAIL-MARK`);
    await writeFile(join(cwd, "GAHAR.md"), "gahar rules");
    const prompt = await buildSystemPromptWithInstructions({
      cwd,
      configDir: join(cwd, "none"),
      model: "m",
      permissionMode: "ask",
    });
    assert.ok(prompt.includes("HEAD-MARK"));
    assert.ok(prompt.includes("TAIL-MARK"));
    assert.ok(prompt.includes("instructions truncated"));
    assert.ok(prompt.includes("gahar rules"));
    const capped = renderInstructions(
      [
        { path: "a", content: big(900), truncated: false },
        { path: "b", content: big(900), truncated: false },
      ],
      1000,
    );
    assert.ok(capped.length <= 1100);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
