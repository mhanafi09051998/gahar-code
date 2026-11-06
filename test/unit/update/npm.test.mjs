import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { formatUpdateNotice, parseUpdateArgs } from "../../../dist/update/command.js";
import { findNpmCli, npmInvocation, quoteForCmd } from "../../../dist/update/npm.js";
import { parseVersionOutput, versionInvocations } from "../../../dist/update/verify.js";

function npmEnv(overrides = {}) {
  return {
    platform: "linux",
    execPath: "/opt/node/bin/node",
    env: {},
    fileExists: () => false,
    ...overrides,
  };
}

test("npm_execpath pointing at npm-cli.js runs npm with the same node binary", () => {
  const cli = "/opt/node/lib/node_modules/npm/bin/npm-cli.js";
  const npm = npmEnv({ env: { npm_execpath: cli }, fileExists: (path) => path === cli });
  assert.deepEqual(npmInvocation(["root", "-g"], npm), {
    command: "/opt/node/bin/node",
    args: [cli, "root", "-g"],
  });
});

test("npm-cli.js next to node.exe is used on Windows", () => {
  const execPath = "C:\\Program Files\\nodejs\\node.exe";
  const npm = npmEnv({
    platform: "win32",
    execPath,
    fileExists: (path) => path.endsWith("npm-cli.js"),
  });
  const found = findNpmCli(npm);
  assert.ok(found.endsWith(join("node_modules", "npm", "bin", "npm-cli.js")));
  assert.equal(npmInvocation(["-v"], npm).command, execPath);
});

test("Windows without npm-cli.js falls back to cmd.exe with quoted arguments", () => {
  const npm = npmEnv({ platform: "win32", env: { ComSpec: "C:\\Windows\\cmd.exe" } });
  const invocation = npmInvocation(["install", "-g", "C:\\Users\\A B\\gahar-code.tgz"], npm);
  assert.equal(invocation.command, "C:\\Windows\\cmd.exe");
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(invocation.args[3], '"npm install -g "C:\\Users\\A B\\gahar-code.tgz""');
});

test("POSIX without npm-cli.js runs npm from PATH", () => {
  assert.deepEqual(npmInvocation(["root", "-g"], npmEnv()), {
    command: "npm",
    args: ["root", "-g"],
  });
});

test("quoteForCmd only quotes arguments that need it", () => {
  assert.equal(quoteForCmd("install"), "install");
  assert.equal(quoteForCmd("a b"), '"a b"');
  assert.equal(quoteForCmd('say "hi"'), '"say ""hi"""');
});

test("versionInvocations falls back to the gahar shim when npm root fails", () => {
  const spawn = () => ({ status: 1 });
  const posix = versionInvocations(spawn, npmEnv());
  assert.deepEqual(posix, [{ command: "gahar", args: ["--version"] }]);
  const win = versionInvocations(spawn, npmEnv({ platform: "win32", env: {} }));
  assert.equal(win.length, 1);
  assert.equal(win[0].args[3], '"gahar --version"');
});

test("parseVersionOutput extracts the version from --version output", () => {
  assert.equal(parseVersionOutput("gahar 1.4.0\n"), "1.4.0");
  assert.equal(parseVersionOutput("1.5.0-rc.1"), "1.5.0-rc.1");
  assert.equal(parseVersionOutput("no version here"), null);
});

test("parseUpdateArgs and formatUpdateNotice", () => {
  assert.deepEqual(parseUpdateArgs([]), { kind: "ok", check: false, force: false });
  assert.deepEqual(parseUpdateArgs(["--force"]), { kind: "ok", check: false, force: true });
  assert.equal(parseUpdateArgs(["now"]).kind, "error");
  const base = { currentVersion: "0.1.0", latestVersion: "0.2.0", releaseUrl: "https://x/r" };
  assert.equal(formatUpdateNotice({ ...base, updateAvailable: false }), null);
  assert.match(
    formatUpdateNotice({ ...base, updateAvailable: true }),
    /0\.1\.0 -> 0\.2\.0\. Run: gahar update/,
  );
});
