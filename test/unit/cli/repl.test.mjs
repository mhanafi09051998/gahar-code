import assert from "node:assert/strict";
import { test } from "node:test";
import { runRepl } from "../../../dist/ui/repl.js";

function scriptedEditor(lines, answers = []) {
  return {
    history: [],
    busy: [],
    async read() {
      const next = lines.shift();
      if (next === undefined) return { kind: "eof" };
      if (next === "^C^C") return { kind: "interrupt" };
      return { kind: "line", text: next };
    },
    async ask() {
      return answers.shift() ?? "";
    },
    setBusy(value) {
      this.busy.push(value);
    },
    close() {
      this.closed = true;
    },
  };
}

function fakeApp(record) {
  return async (options) => ({
    sessionId: "s-1",
    meta: { model: "acme/coder", title: "t", messageCount: 0 },
    getUsage: () => ({}),
    async runTurn(input) {
      record.inputs.push(input);
      if (input === "fail") throw new Error("model exploded");
      record.decisions.push(
        await options.approvals.request({ tool: "run_command", action: "shell", title: "Run ls" }),
      );
      options.events({ type: "text_delta", at: "t", text: "done" });
      return { text: "done", usage: { total_tokens: 3 }, durationMs: 1, finishReason: "stop" };
    },
    compact: async () => {},
    undo: async () => false,
    setModel: () => {},
    close: async () => {
      record.closed = true;
    },
  });
}

async function repl(lines, answers) {
  const record = { inputs: [], decisions: [] };
  const chunks = [];
  const editor = scriptedEditor(lines, answers);
  const outcome = await runRepl({
    cwd: "/work",
    configDir: "/cfg",
    stderr: { write: (chunk) => chunks.push(chunk) },
    color: false,
    columns: 80,
    createApp: fakeApp(record),
    appOptions: { config: { permissionMode: "ask" } },
    editor,
  });
  return { outcome, record, editor, text: chunks.join("") };
}

test("repl runs turns, prompts approvals through the editor and handles slash commands", async () => {
  const { outcome, record, editor, text } = await repl(
    ["hello", "/status", "", "fail", "/exit", "never sent"],
    ["y"],
  );
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.turns, 1);
  assert.deepEqual(record.inputs, ["hello", "fail"]);
  assert.deepEqual(record.decisions, ["allow"]);
  assert.match(text, /Gahar Code/);
  assert.match(text, /Run ls \(shell\)/);
  assert.match(text, /session {2}s-1/);
  assert.match(text, /error: model exploded/);
  assert.deepEqual(editor.busy, [true, false, true, false]);
  assert.equal(editor.closed, true);
  assert.equal(record.closed, true);
});

test("repl exits with 130 on a double Ctrl+C", async () => {
  const { outcome } = await repl(["^C^C"]);
  assert.equal(outcome.exitCode, 130);
});
