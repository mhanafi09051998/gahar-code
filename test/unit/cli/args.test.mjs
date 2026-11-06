import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXIT_ARG_ERROR,
  EXIT_AUTH_ERROR,
  EXIT_INTERRUPT,
  helpText,
  parseArgs,
  versionText,
} from "../../../dist/cli/args.js";
import { VERSION } from "../../../dist/shared/version.js";

test("exit codes follow the brief", () => {
  assert.equal(EXIT_ARG_ERROR, 2);
  assert.equal(EXIT_AUTH_ERROR, 3);
  assert.equal(EXIT_INTERRUPT, 130);
});

test("bare invocation starts the REPL", () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.kind, "run");
  assert.equal(parsed.prompt, null);
  assert.equal(parsed.options.json, false);
});

test("help and version flags and aliases", () => {
  for (const flag of ["--help", "-h", "help"])
    assert.deepEqual(parseArgs([flag]), { kind: "help" });
  for (const flag of ["--version", "-v"]) assert.deepEqual(parseArgs([flag]), { kind: "version" });
  assert.match(helpText(), /--permission-mode/);
  assert.match(helpText(), /update \[--check\] \[--force\]/);
  assert.equal(versionText(), `gahar ${VERSION}`);
});

test("prompt forms: -p, --print and positional", () => {
  assert.equal(parseArgs(["-p", "hi there"]).prompt, "hi there");
  assert.equal(parseArgs(["--print", "x"]).prompt, "x");
  assert.equal(parseArgs(["fix", "the", "test"]).prompt, "fix the test");
  assert.equal(parseArgs(["--", "--not-a-flag"]).prompt, "--not-a-flag");
});

test("value flags accept separate and inline values", () => {
  const parsed = parseArgs([
    "--model",
    "openai/gpt-5.1-codex",
    "--permission-mode=auto-edit",
    "--max-tokens",
    "4096",
    "-p",
    "go",
  ]);
  assert.equal(parsed.kind, "run");
  assert.equal(parsed.options.model, "openai/gpt-5.1-codex");
  assert.equal(parsed.options.permissionMode, "auto-edit");
  assert.equal(parsed.options.maxTokens, 4096);
  assert.equal(parseArgs(["-m", "a/b"]).options.model, "a/b");
});

test("boolean flags", () => {
  const { options } = parseArgs([
    "--json",
    "-c",
    "--no-update-check",
    "--debug",
    "--no-color",
    "-q",
  ]);
  assert.equal(options.json, true);
  assert.equal(options.continue, true);
  assert.equal(options.noUpdateCheck, true);
  assert.equal(options.debug, true);
  assert.equal(options.noColor, true);
  assert.equal(options.quiet, true);
  assert.equal(parseArgs(["--continue"]).options.continue, true);
});

test("--yolo is an alias for full-auto", () => {
  assert.equal(parseArgs(["--yolo"]).options.permissionMode, "full-auto");
});

test("-r/--resume takes an optional session id", () => {
  const id = "20261107-120000-abcd1234";
  assert.equal(parseArgs(["-r", id]).options.resume, id);
  assert.equal(parseArgs([`--resume=${id}`]).options.resume, id);
  const latest = parseArgs(["-r", "fix it"]);
  assert.equal(latest.options.resume, undefined);
  assert.equal(latest.options.continue, true);
  assert.equal(latest.prompt, "fix it");
  assert.equal(parseArgs(["--resume"]).options.continue, true);
});

test("subcommands keep their own arguments and flags", () => {
  assert.deepEqual(pick(parseArgs(["update", "--check", "--force"])), [
    "update",
    ["--check", "--force"],
  ]);
  assert.deepEqual(pick(parseArgs(["auth", "login"])), ["auth", ["login"]]);
  assert.deepEqual(pick(parseArgs(["model", "set", "x/y"])), ["model", ["set", "x/y"]]);
  assert.deepEqual(pick(parseArgs(["sessions", "rm", "id1"])), ["sessions", ["rm", "id1"]]);
  assert.deepEqual(pick(parseArgs(["doctor"])), ["doctor", []]);
  assert.deepEqual(pick(parseArgs(["setup"])), ["setup", []]);
  const withGlobal = parseArgs(["--no-color", "model", "list"]);
  assert.equal(withGlobal.options.noColor, true);
});

test("argument errors", () => {
  const cases = [
    [["--bogus"], /unknown option: --bogus/],
    [["--model"], /missing value for --model/],
    [["--model="], /missing value for --model/],
    [["-p"], /missing value for -p/],
    [["--permission-mode", "sometimes"], /invalid permission mode/],
    [["--max-tokens", "0"], /invalid value for --max-tokens/],
    [["--max-tokens", "lots"], /invalid value for --max-tokens/],
    [["--json=yes"], /does not take a value/],
    [["--resume="], /missing value for --resume/],
  ];
  for (const [argv, pattern] of cases) {
    const parsed = parseArgs(argv);
    assert.equal(parsed.kind, "error", argv.join(" "));
    assert.match(parsed.message, pattern);
    assert.match(parsed.message, /gahar --help/);
  }
});

function pick(parsed) {
  assert.equal(parsed.kind, "command");
  return [parsed.name, parsed.args];
}
