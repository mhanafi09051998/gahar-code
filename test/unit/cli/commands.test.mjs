import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runAuth } from "../../../dist/cli/auth-cmd.js";
import { dispatchSlash, findCommand, SLASH_COMMANDS } from "../../../dist/cli/commands.js";
import { doctorExitCode, runChecks, runDoctor } from "../../../dist/cli/doctor.js";
import { runModel } from "../../../dist/cli/model-cmd.js";
import { formatContext, perMillion, topModels } from "../../../dist/cli/model-format.js";
import { createQuestioner } from "../../../dist/cli/questioner.js";
import { runSessions } from "../../../dist/cli/sessions-cmd.js";
import { resolveChoice, runSetup } from "../../../dist/cli/setup.js";
import { runUpdate } from "../../../dist/cli/update-cmd.js";

const KEY = "sk-or-v1-test-0000000000000000";
const dirs = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function captureIO() {
  const out = [];
  const err = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

const CATALOG = [
  {
    id: "anthropic/claude-sonnet-4.6",
    context_length: 1_000_000,
    pricing: { prompt: "0.000003", completion: "0.000015" },
    supported_parameters: ["tools"],
  },
  { id: "acme/no-tools", context_length: 8000, supported_parameters: ["temperature"] },
  { id: "acme/coder", context_length: 128000, pricing: { prompt: "0", completion: "0" } },
];

function loadedConfig(apiKey = KEY) {
  return {
    config: { apiKey, apiKeySource: apiKey ? "config" : "none", model: "acme/coder" },
    globalPath: "/home/u/.gahar/config.json",
    projectPath: null,
    globalConfig: { version: 1 },
    projectConfig: null,
  };
}

function fakeApp() {
  const calls = [];
  return {
    calls,
    sessionId: "s-1",
    meta: { title: "t", model: "acme/coder", messageCount: 2 },
    getUsage: () => ({ total_tokens: 10, prompt_tokens: 7, completion_tokens: 3, cost: 0.5 }),
    compact: async () => calls.push("compact"),
    undo: async () => false,
    setModel: (id) => calls.push(`model:${id}`),
  };
}

test("slash command table covers the brief", () => {
  const names = SLASH_COMMANDS.map((command) => command.name);
  for (const name of ["/help", "/model", "/auth", "/init", "/compact", "/clear", "/undo"]) {
    assert.ok(names.includes(name), name);
  }
  for (const name of ["/cost", "/status", "/permissions", "/verbose", "/exit"]) {
    assert.ok(findCommand(name), name);
  }
});

test("dispatchSlash runs commands, prints help for unknown ones and ignores prompts", async () => {
  const app = fakeApp();
  const printed = [];
  let verbose = false;
  let exited = false;
  const base = {
    app,
    cwd: await mkdtemp(join(tmpdir(), "gahar-slash-")),
    envKey: false,
    verbose,
    setVerbose: (value) => {
      verbose = value;
    },
    clearScreen: () => {},
    requestExit: () => {
      exited = true;
    },
    print: (line) => printed.push(line),
  };
  dirs.push(base.cwd);
  assert.equal(await dispatchSlash("fix the bug", base), false);
  assert.equal(await dispatchSlash("/model x/y", base), true);
  assert.deepEqual(app.calls, ["model:x/y"]);
  await dispatchSlash("/compact", base);
  assert.equal(app.calls.at(-1), "compact");
  await dispatchSlash("/cost", base);
  assert.match(printed.at(-1), /tokens: 10 .* cost \$0\.5000/);
  await dispatchSlash("/verbose", base);
  assert.equal(verbose, true);
  assert.equal(printed.at(-1), "verbose on");
  await dispatchSlash("/init", base);
  assert.match(await readFile(join(base.cwd, "AGENTS.md"), "utf8"), /# AGENTS.md/);
  await dispatchSlash("/nope", base);
  assert.match(printed.at(-1), /unknown command \/nope[\s\S]*\/help/);
  await dispatchSlash("/exit", base);
  assert.equal(exited, true);
});

test("model formatting helpers", () => {
  assert.equal(perMillion("0.000003"), "$3.00");
  assert.equal(perMillion("0"), "free");
  assert.equal(perMillion(undefined), "?");
  assert.equal(formatContext(1_000_000), "1M");
  assert.equal(formatContext(128000), "128k");
  const top = topModels(CATALOG, 5).map((model) => model.id);
  assert.deepEqual(top, ["anthropic/claude-sonnet-4.6", "acme/coder"]);
  assert.ok(topModels([], 10).length > 0, "falls back to recommendations offline");
});

test("model list/set/show", async () => {
  const saved = [];
  const deps = {
    loaded: loadedConfig(),
    listModels: async () => CATALOG,
    saveModel: async (model) => {
      saved.push(model);
      return "/cfg.json";
    },
  };
  let c = captureIO();
  assert.equal(await runModel(["list"], deps, c.io), 0);
  assert.match(c.out.join("\n"), /\* 2 acme\/coder/);
  assert.match(c.out.join("\n"), /\$3\.00/);
  c = captureIO();
  assert.equal(await runModel(["set", "missing/model"], deps, c.io), 2);
  assert.deepEqual(saved, []);
  assert.equal(await runModel(["set", "acme/coder"], deps, c.io), 0);
  assert.deepEqual(saved, ["acme/coder"]);
  c = captureIO();
  assert.equal(await runModel([], deps, c.io), 0);
  assert.equal(c.out[0], "model: acme/coder");
  assert.equal(await runModel(["bogus"], deps, c.io), 2);
});

test("auth status/login/logout", async () => {
  const saved = [];
  const client = {
    validateKey: async (key) => {
      if (key !== KEY) throw new Error("401 invalid key");
      return { label: "test", usage: 1, limit: null, limit_remaining: 9 };
    },
  };
  const deps = (answers, apiKey = KEY) => ({
    loaded: loadedConfig(apiKey),
    client,
    questioner: createQuestioner({ stderr: { write() {} }, interactive: true, answers }),
    saveKey: async (key) => saved.push(key),
    clearKey: async () => true,
    envKeySet: false,
  });
  let c = captureIO();
  assert.equal(await runAuth("status", deps([]), c.io), 0);
  assert.match(c.out.join("\n"), /key: {4}sk-or-v1\.\.\.0000/);
  assert.doesNotMatch(c.out.join("\n"), new RegExp(KEY));
  assert.equal(await runAuth("status", deps([], null), captureIO().io), 3);
  c = captureIO();
  assert.equal(await runAuth("login", deps(["sk-or-v1-wrong-000000000000"]), c.io), 3);
  assert.equal(await runAuth("login", deps([""]), c.io), 3);
  assert.equal(await runAuth("login", deps([KEY]), c.io), 0);
  assert.deepEqual(saved, [KEY]);
  assert.equal(await runAuth("logout", deps([]), c.io), 0);
  assert.equal(await runAuth("whoami", deps([]), c.io), 2);
});

test("setup flow with injected client and config", async () => {
  const patches = [];
  const client = {
    validateKey: async (key) => {
      if (key !== KEY) throw new Error("401");
      return {};
    },
    listModels: async () => CATALOG,
  };
  const make = (answers, env = {}, global = { version: 1 }) => ({
    env,
    questioner: createQuestioner({ stderr: { write() {} }, interactive: true, answers }),
    client,
    readGlobal: async () => global,
    save: async (patch) => {
      patches.push(patch);
      return "/cfg/config.json";
    },
  });
  const c = captureIO();
  assert.equal(await runSetup(make(["bad", KEY, "2"]), c.io), 0);
  assert.deepEqual(patches, [{ apiKey: KEY }, { model: "acme/coder" }]);
  assert.match(c.out.join("\n"), /Setup complete/);

  patches.length = 0;
  const viaEnv = make([], { OPENROUTER_API_KEY: KEY, GAHAR_MODEL: "acme/coder" });
  viaEnv.questioner = createQuestioner({ stderr: { write() {} }, interactive: false });
  assert.equal(await runSetup(viaEnv, captureIO().io), 0);
  assert.deepEqual(patches, [{ model: "acme/coder" }], "env key is never written to disk");

  const noKey = make([]);
  noKey.questioner = createQuestioner({ stderr: { write() {} }, interactive: false });
  assert.equal(await runSetup(noKey, captureIO().io), 3);
  assert.equal(resolveChoice("", CATALOG, "d"), "d");
  assert.equal(resolveChoice("9", CATALOG, "d"), null);
  assert.equal(resolveChoice("x/y", CATALOG, "d"), "x/y");
});

function probes(overrides = {}) {
  return {
    nodeVersion: "v22.1.0",
    configDir: "/cfg",
    apiKey: KEY,
    model: "acme/coder",
    checkConfigDirWritable: async () => {},
    networkReachable: async () => true,
    validateKey: async () => ({}),
    modelExists: async () => true,
    commandAvailable: async (cmd) => cmd !== "pwsh",
    installLocation: () => "/usr/lib/node_modules/gahar-code",
    latestVersion: async () => ({ current: "0.1.0", latest: "0.1.0", newer: false }),
    ...overrides,
  };
}

test("doctor aggregates PASS/WARN/FAIL and exits 1 only on FAIL", async () => {
  const healthy = await runChecks(probes());
  assert.ok(
    healthy.every((check) => check.status === "PASS"),
    JSON.stringify(healthy),
  );
  assert.equal(doctorExitCode(healthy), 0);

  const offline = await runChecks(probes({ networkReachable: async () => false }));
  const byName = Object.fromEntries(offline.map((check) => [check.name, check.status]));
  assert.equal(byName.network, "WARN");
  assert.equal(byName["api key"], "WARN");
  assert.equal(doctorExitCode(offline), 0);

  const c = captureIO();
  const broken = probes({
    nodeVersion: "v18.0.0",
    apiKey: null,
    checkConfigDirWritable: async () => {
      throw new Error("EACCES");
    },
    commandAvailable: async () => false,
    latestVersion: async () => ({ current: "0.1.0", latest: "0.2.0", newer: true }),
  });
  assert.equal(await runDoctor(broken, c.io), 1);
  const text = c.out.join("\n");
  assert.match(text, /^FAIL {2}node/m);
  assert.match(text, /FAIL {2}config dir .*EACCES/);
  assert.match(text, /FAIL {2}api key/);
  assert.match(text, /WARN {2}shell/);
  assert.match(text, /WARN {2}release .*0\.2\.0/);
});

test("update command: --check, install and argument errors", async () => {
  const deps = {
    check: async () => ({
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      updateAvailable: true,
      releaseUrl: "https://example.test/r",
    }),
    perform: async (options) => ({ updated: true, message: `updated force=${options.force}` }),
  };
  let c = captureIO();
  assert.equal(await runUpdate(["--check"], deps, c.io), 0);
  assert.match(c.out.join("\n"), /latest: {2}0\.2\.0[\s\S]*Update available/);
  c = captureIO();
  assert.equal(await runUpdate(["--force"], deps, c.io), 0);
  assert.equal(c.out[0], "updated force=true");
  assert.equal(await runUpdate(["--nope"], deps, captureIO().io), 2);
  const failing = { ...deps, check: async () => Promise.reject(new Error("offline")) };
  c = captureIO();
  assert.equal(await runUpdate(["--check"], failing, c.io), 1);
  assert.equal(c.err[0], "offline");
});

test("sessions: empty project, unknown ids and usage errors", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "gahar-sessions-"));
  dirs.push(configDir);
  const deps = { configDir, cwd: configDir };
  const c = captureIO();
  assert.equal(await runSessions([], deps, c.io), 0);
  assert.equal(c.out[0], "no sessions in this project yet");
  assert.equal(await runSessions(["show", "../../etc"], deps, c.io), 1);
  assert.equal(await runSessions(["rm"], deps, c.io), 2);
  assert.equal(await runSessions(["purge"], deps, c.io), 2);
});
