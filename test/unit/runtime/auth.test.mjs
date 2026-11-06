import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { maskKey, requireApiKey, resolveApiKey } from "../../../dist/auth/key.js";
import { formatAuthStatus, login, logout, status } from "../../../dist/auth/login.js";
import { GaharError } from "../../../dist/shared/errors.js";

const KEY = "sk-or-v1-test-abcdefghijklmnop-wxyz";
const REJECTED = "sk-or-v1-test-rejected-000000";
const INFO = { label: "t", limit: 10, usage: 2.5, limit_remaining: 7.5, is_free_tier: false };

function fakeValidator() {
  const calls = [];
  return {
    calls,
    async validateKey(key) {
      calls.push(key);
      if (key === REJECTED) throw new GaharError("rejected", { code: "unauthorized", exitCode: 3 });
      return INFO;
    },
  };
}

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "gahar-auth-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("maskKey shows only the first 8 and last 4 characters", () => {
  assert.equal(maskKey(KEY), "sk-or-v1...wxyz");
  assert.ok(!maskKey(KEY).includes("abcdefgh"));
  assert.equal(maskKey(""), "(none)");
  assert.equal(maskKey(null), "(none)");
  assert.equal(maskKey("short-key"), "sh...ey");
});

test("resolveApiKey follows the resolved config source", () => {
  assert.deepEqual(resolveApiKey({ apiKey: KEY, apiKeySource: "env" }), {
    key: KEY,
    source: "env",
  });
  assert.deepEqual(resolveApiKey({ config: { apiKey: KEY, apiKeySource: "config" } }), {
    key: KEY,
    source: "config",
  });
  assert.deepEqual(resolveApiKey({ apiKey: "  ", apiKeySource: "config" }), {
    key: null,
    source: "none",
  });
  assert.throws(
    () => requireApiKey({ key: null, source: "none" }),
    (e) => e.exitCode === 3,
  );
});

test("login validates once, persists, and status never prints the full key", async () => {
  await withDir(async (dir) => {
    const validator = fakeValidator();
    const result = await login(validator, `  ${KEY}  `, dir);
    assert.deepEqual(validator.calls, [KEY]);
    assert.equal(result.maskedKey, "sk-or-v1...wxyz");
    assert.deepEqual(result.info, INFO);
    const saved = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
    assert.equal(saved.apiKey, KEY);

    const current = await status(validator, { apiKey: KEY, apiKeySource: "config" }, dir);
    const report = formatAuthStatus(current);
    assert.ok(report.includes("sk-or-v1...wxyz"));
    assert.ok(!report.includes(KEY));
    assert.ok(report.includes("Remaining: $7.5000"));

    assert.deepEqual(await logout(dir), { removed: true, configPath: join(dir, "config.json") });
    const cleared = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
    assert.equal(cleared.apiKey, undefined);
  });
});

test("login rejects malformed or invalid keys without saving", async () => {
  await withDir(async (dir) => {
    const validator = fakeValidator();
    await assert.rejects(
      () => login(validator, "not-a-key", dir),
      (e) => e.exitCode === 3,
    );
    await assert.rejects(
      () => login(validator, REJECTED, dir),
      (e) => e.exitCode === 3,
    );
    await assert.rejects(() => readFile(join(dir, "config.json"), "utf8"), { code: "ENOENT" });
  });
});

test("status without a key reports none and skips the network", async () => {
  const validator = fakeValidator();
  const result = await status(validator, { apiKey: null, apiKeySource: "none" }, tmpdir());
  assert.equal(result.source, "none");
  assert.equal(result.maskedKey, "(none)");
  assert.equal(result.info, null);
  assert.equal(validator.calls.length, 0);
});
