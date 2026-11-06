import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import { runUpdateCommand } from "../../../dist/update/command.js";
import {
  parseChecksumFile,
  performUpdate,
  releaseAssetUrl,
  releaseChecksumUrl,
} from "../../../dist/update/install.js";
import { MANUAL_INSTALL_COMMAND } from "../../../dist/update/npm.js";
import { REPO, releaseRoutes, startMockGitHub, withTempDir } from "./helpers.mjs";

const NPM = {
  platform: "linux",
  execPath: "/usr/bin/node",
  env: {},
  fileExists: (path) => /dist[\\/]cli\.js$/.test(path),
};

/** Fake spawn: npm install exits with installStatus, the CLI reports reportedVersion. */
function fakeSpawn({ installStatus = 0, reportedVersion = "0.2.0" } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "install") return { status: installStatus, stderr: "npm ERR! EACCES" };
    if (args[0] === "root") return { status: 0, stdout: "/fake/global/node_modules\n" };
    if (args.includes("--version")) return { status: 0, stdout: `gahar ${reportedVersion}\n` };
    return { status: 1 };
  };
  return { calls, spawnImpl };
}

async function runUpdate(routes, spawnOptions, options = {}) {
  const mock = await startMockGitHub(routes);
  const spawn = fakeSpawn(spawnOptions);
  const logs = [];
  try {
    return await withTempDir(async (tempRoot) => {
      const seams = {
        repo: REPO,
        currentVersion: "0.1.0",
        fetchImpl: mock.fetchImpl,
        spawnImpl: spawn.spawnImpl,
        npm: NPM,
        tempRoot,
      };
      const run = performUpdate({ onLog: (line) => logs.push(line), ...options }, seams);
      const outcome = await run.then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
      const leftover = await readdir(tempRoot);
      return { ...outcome, calls: spawn.calls, logs, requests: mock.requests, leftover };
    });
  } finally {
    await mock.close();
  }
}

test("asset and checksum URLs match the release workflow names", () => {
  assert.equal(
    releaseAssetUrl(REPO, "v1.2.3"),
    `https://github.com/${REPO}/releases/download/v1.2.3/gahar-code.tgz`,
  );
  assert.equal(
    releaseAssetUrl(REPO),
    `https://github.com/${REPO}/releases/latest/download/gahar-code.tgz`,
  );
  assert.equal(releaseChecksumUrl(REPO, "latest"), `${releaseAssetUrl(REPO)}.sha256`);
  assert.match(
    MANUAL_INSTALL_COMMAND,
    /^npm install -g https:\/\/github\.com\/.+\/gahar-code\.tgz$/,
  );
});

test("parseChecksumFile accepts sha256sum output and rejects junk", () => {
  const hex = "A".repeat(64);
  assert.equal(parseChecksumFile(`${hex}  gahar-code.tgz\n`), "a".repeat(64));
  assert.equal(parseChecksumFile(`\n${hex}\n`), "a".repeat(64));
  assert.equal(parseChecksumFile("not a checksum"), null);
  assert.equal(parseChecksumFile(""), null);
});

test("already up to date: no download and no npm run", async () => {
  const run = await runUpdate(releaseRoutes({ tag: "v0.1.0" }));
  assert.equal(run.error, undefined);
  assert.equal(run.result.updated, false);
  assert.match(run.result.message, /already up to date/);
  assert.equal(run.requests.length, 1);
  assert.equal(run.calls.length, 0);
});

test("checkOnly reports an available update without installing", async () => {
  const run = await runUpdate(releaseRoutes({ tag: "v0.2.0" }), {}, { checkOnly: true });
  assert.equal(run.result.updated, false);
  assert.match(run.result.message, /Update available: v0\.1\.0 -> v0\.2\.0/);
  assert.equal(run.calls.length, 0);
});

test("checksum mismatch refuses to install", async () => {
  const run = await runUpdate(releaseRoutes({ checksum: "0".repeat(64) }));
  assert.match(run.error.message, /Checksum mismatch/);
  assert.match(run.error.message, /Install manually: npm install -g/);
  assert.equal(run.calls.length, 0);
});

test("success downloads, installs the tarball with npm and verifies the version", async () => {
  const run = await runUpdate(releaseRoutes({ tag: "v0.2.0" }));
  assert.equal(run.error, undefined);
  assert.deepEqual(
    { updated: run.result.updated, latest: run.result.latestVersion },
    { updated: true, latest: "0.2.0" },
  );
  const install = run.calls.find((call) => call.args[0] === "install");
  assert.equal(install.command, "npm");
  assert.deepEqual(install.args.slice(0, 3), ["install", "-g", "--force"]);
  assert.match(install.args[3], /gahar-code\.tgz$/);
  assert.equal(install.options.stdio, "inherit");
  const verify = run.calls.find((call) => call.args.includes("--version"));
  assert.equal(verify.command, NPM.execPath);
  assert.match(verify.args[0], /gahar-code[\\/]dist[\\/]cli\.js$/);
  assert.deepEqual(run.leftover, [], "temp download dir is removed");
  assert.ok(run.logs.includes("Checksum verified."));
});

test("npm failure reports the reason and the manual command", async () => {
  const run = await runUpdate(releaseRoutes(), { installStatus: 1 });
  assert.match(run.error.message, /npm install failed \(npm ERR! EACCES\)/);
  assert.ok(run.error.message.includes(MANUAL_INSTALL_COMMAND));
});

test("a version mismatch after install is reported", async () => {
  const run = await runUpdate(releaseRoutes(), { reportedVersion: "0.1.0" });
  assert.match(run.error.message, /reports v0\.1\.0 but v0\.2\.0 was expected/);
});

test("an unreachable release API fails with the manual command", async () => {
  const run = await runUpdate({});
  assert.match(run.error.message, /no published release/);
  assert.ok(run.error.message.includes(MANUAL_INSTALL_COMMAND));
});

test("runUpdateCommand maps outcomes to exit codes", async () => {
  const out = [];
  const err = [];
  const io = { stdout: (line) => out.push(line), stderr: (line) => err.push(line) };
  assert.equal(await runUpdateCommand(["--bogus"], io), 2);
  assert.equal(await runUpdateCommand(["--check", "--force"], io), 2);
  const mock = await startMockGitHub(releaseRoutes({ tag: "v0.2.0" }));
  try {
    const seams = { repo: REPO, currentVersion: "0.1.0", fetchImpl: mock.fetchImpl };
    assert.equal(await runUpdateCommand(["--check"], io, seams), 0);
    assert.ok(out.some((line) => line.startsWith("Release notes:")));
    const failing = { ...seams, repo: "example/missing" };
    assert.equal(await runUpdateCommand([], io, failing), 1);
    assert.match(err.at(-1), /Install manually/);
  } finally {
    await mock.close();
  }
});
