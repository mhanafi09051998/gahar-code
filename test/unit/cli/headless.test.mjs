import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { failureExitCode, runHeadless } from "../../../dist/cli/headless.js";
import { JsonEventWriter, parseEventLine, serialize } from "../../../dist/cli/json-output.js";
import { runCli } from "../../../dist/cli/main.js";
import { GaharError } from "../../../dist/shared/errors.js";

const dirs = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function sink() {
  const chunks = [];
  return { write: (chunk) => chunks.push(chunk), text: () => chunks.join("") };
}

const USAGE = { total_tokens: 12, cost: 0.001 };

/** Fake App: streams text, asks for one write approval, records the decision. */
function fakeCreateApp(record, behavior = {}) {
  return async (options) => {
    record.options = options;
    return {
      sessionId: "sess-1",
      meta: { model: "acme/coder" },
      getUsage: () => USAGE,
      async runTurn(input, signal) {
        record.input = input;
        if (behavior.fail) throw behavior.fail;
        if (behavior.waitForAbort) {
          await new Promise((resolve) => signal.addEventListener("abort", resolve));
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }
        options.events({ type: "text_delta", at: "t", text: "Hello " });
        record.decision = await options.approvals.request({
          tool: "write_file",
          action: "write",
          title: "Write a.txt",
        });
        options.events({ type: "text_delta", at: "t", text: "world" });
        return { text: "Hello world", usage: USAGE, durationMs: 5, finishReason: "stop" };
      },
      compact: async () => {},
      undo: async () => false,
      setModel: () => {},
      close: async () => {
        record.closed = true;
      },
    };
  };
}

function baseOptions(record, extra = {}) {
  return {
    prompt: "say hi",
    cwd: "/work",
    json: false,
    color: false,
    stdout: sink(),
    stderr: sink(),
    createApp: fakeCreateApp(record, extra.behavior),
    appOptions: {
      config: { permissionMode: "ask" },
      approvals: { request: async () => "deny" },
    },
    ...extra,
  };
}

test("json writer emits one parseable event per line and is a no-op when disabled", () => {
  const out = sink();
  const writer = new JsonEventWriter({ stdout: out, enabled: true });
  writer.emit({ type: "text_delta", at: "t", text: "a\nb" });
  writer.emitError("boom", "x");
  const lines = out.text().trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(parseEventLine(lines[0]), { type: "text_delta", at: "t", text: "a\nb" });
  assert.equal(parseEventLine(lines[1]).code, "x");
  assert.equal(parseEventLine("not json"), null);
  assert.equal(parseEventLine('{"no":"type"}'), null);
  const cyclic = { type: "notice" };
  cyclic.self = cyclic;
  assert.equal(JSON.parse(serialize(cyclic)).type, "error");
  const quiet = sink();
  new JsonEventWriter({ stdout: quiet, enabled: false }).emit({ type: "notice" });
  assert.equal(quiet.text(), "");
});

test("headless plain mode streams the answer to stdout and logs to stderr", async () => {
  const record = {};
  const options = baseOptions(record);
  const outcome = await runHeadless(options);
  assert.equal(outcome.exitCode, 0);
  assert.equal(options.stdout.text(), "Hello world\n");
  assert.match(options.stderr.text(), /12 tokens/);
  assert.equal(record.decision, "deny", "non-TTY approvals deny so the run cannot hang");
  assert.equal(record.closed, true);
});

test("headless json mode writes only JSONL events to stdout", async () => {
  const record = {};
  const options = baseOptions(record, { json: true });
  const outcome = await runHeadless(options);
  assert.equal(outcome.exitCode, 0);
  const events = options.stdout.text().trimEnd().split("\n").map(parseEventLine);
  assert.deepEqual(
    events.map((event) => event.type),
    ["init", "text_delta", "text_delta", "result"],
  );
  assert.equal(events[0].sessionId, "sess-1");
  assert.equal(events[3].text, "Hello world");
  assert.equal(events[3].isError, false);
  assert.equal(options.stderr.text(), "");
});

test("headless maps failures to exit codes", async () => {
  const auth = baseOptions(
    {},
    {
      json: true,
      behavior: { fail: new GaharError("bad key", { exitCode: 3, code: "unauthorized" }) },
    },
  );
  assert.equal((await runHeadless(auth)).exitCode, 3);
  const last = parseEventLine(auth.stdout.text().trimEnd().split("\n").at(-1));
  assert.equal(last.type, "error");
  assert.equal(last.code, "unauthorized");

  const plain = baseOptions({}, { behavior: { fail: new Error("kaput") } });
  assert.equal((await runHeadless(plain)).exitCode, 1);
  assert.match(plain.stderr.text(), /error: kaput/);

  let abort;
  const interrupted = baseOptions(
    {},
    {
      behavior: { waitForAbort: true },
      installSignals: (fn) => {
        abort = fn;
        return () => {};
      },
    },
  );
  const pending = runHeadless(interrupted);
  await new Promise((resolve) => setTimeout(resolve, 10));
  abort();
  assert.equal((await pending).exitCode, 130);

  assert.equal(failureExitCode(new Error("401 Unauthorized")), 3);
});

async function cli(argv, env = {}, record = {}) {
  const stdout = sink();
  const stderr = sink();
  const configDir = await mkdtemp(join(tmpdir(), "gahar-main-"));
  dirs.push(configDir);
  const code = await runCli(argv, {
    createApp: fakeCreateApp(record),
    installSignals: () => () => {},
    env: {
      cwd: configDir,
      configDir,
      env: { GAHAR_CONFIG_DIR: configDir, GAHAR_NO_UPDATE_CHECK: "1", ...env },
      stdout,
      stderr,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    },
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

test("runCli: help, version and argument errors", async () => {
  const help = await cli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage:/);
  assert.match((await cli(["--version"])).stdout, /^gahar \d+\.\d+\.\d+/);
  const bad = await cli(["--wat"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown option: --wat/);
});

test("runCli: missing key exits 3, a key runs the prompt headless", async () => {
  const noKey = await cli(["-p", "hi"], { OPENROUTER_API_KEY: "" });
  assert.equal(noKey.code, 3);
  assert.match(noKey.stderr, /No OpenRouter API key/);
  const noKeyJson = await cli(["-p", "hi", "--json"], { OPENROUTER_API_KEY: "" });
  assert.equal(parseEventLine(noKeyJson.stdout.trim()).type, "error");

  const record = {};
  const ok = await cli(
    ["-p", "hi", "-c"],
    { OPENROUTER_API_KEY: "sk-or-v1-test-000000000000" },
    record,
  );
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout, "Hello world\n");
  assert.equal(record.input, "hi");
  assert.deepEqual(record.options.resume, { type: "latest" });
  assert.equal(record.decision, "deny");
});
