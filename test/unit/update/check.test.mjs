import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import {
  checkForUpdate,
  checkForUpdateOrThrow,
  toUpdateCheckResult,
  UPDATE_CACHE_TTL_MS,
  updateCachePath,
  updateCheckDisabled,
} from "../../../dist/update/check.js";
import { REPO, releaseRoutes, startMockGitHub, withTempDir } from "./helpers.mjs";

const BASE = { repo: REPO, currentVersion: "0.1.0", env: {} };

test("checkForUpdate parses the latest release from the GitHub API", async () => {
  const mock = await startMockGitHub(releaseRoutes({ tag: "v0.2.0" }));
  try {
    const result = await checkForUpdate({ ...BASE, fetchImpl: mock.fetchImpl });
    assert.equal(result.latestVersion, "0.2.0");
    assert.equal(result.updateAvailable, true);
    assert.equal(result.releaseUrl, `https://github.com/${REPO}/releases/tag/v0.2.0`);
    const headers = mock.requests[0].headers;
    assert.equal(headers["user-agent"], "gahar-code-cli");
    assert.match(headers.accept, /github/);
    assert.equal(headers.authorization, undefined);
  } finally {
    await mock.close();
  }
});

test("toUpdateCheckResult rejects tags that are not semver", () => {
  assert.equal(toUpdateCheckResult({ tag_name: "nightly" }, "0.1.0", REPO), null);
  assert.equal(toUpdateCheckResult({}, "0.1.0", REPO), null);
  const same = toUpdateCheckResult({ tag_name: "v0.1.0" }, "0.1.0", REPO);
  assert.equal(same.updateAvailable, false);
});

test("results are cached for 24h and refreshed after expiry", async () => {
  await withTempDir(async (configDir) => {
    const mock = await startMockGitHub(releaseRoutes({ tag: "v0.2.0" }));
    try {
      let clock = 1_000_000;
      const options = { ...BASE, configDir, fetchImpl: mock.fetchImpl, now: () => clock };
      await checkForUpdate(options);
      const cached = JSON.parse(await readFile(updateCachePath(configDir), "utf8"));
      assert.equal(cached.result.latestVersion, "0.2.0");
      clock += UPDATE_CACHE_TTL_MS - 1;
      await checkForUpdate(options);
      assert.equal(mock.requests.length, 1, "served from cache within the TTL");
      clock += 2;
      await checkForUpdate(options);
      assert.equal(mock.requests.length, 2, "refetched after the TTL");
      await checkForUpdate({ ...options, allowCache: false });
      assert.equal(mock.requests.length, 3, "allowCache false bypasses the cache");
    } finally {
      await mock.close();
    }
  });
});

test("a cached result is re-evaluated against the installed version", async () => {
  await withTempDir(async (configDir) => {
    const mock = await startMockGitHub(releaseRoutes({ tag: "v0.2.0" }));
    try {
      const options = { ...BASE, configDir, fetchImpl: mock.fetchImpl, now: () => 5 };
      await checkForUpdate(options);
      const after = await checkForUpdate({ ...options, currentVersion: "0.2.0" });
      assert.equal(after.updateAvailable, false);
      assert.equal(after.currentVersion, "0.2.0");
    } finally {
      await mock.close();
    }
  });
});

test("a corrupt cache file is ignored", async () => {
  await withTempDir(async (configDir) => {
    const mock = await startMockGitHub(releaseRoutes());
    try {
      const options = { ...BASE, configDir, fetchImpl: mock.fetchImpl, now: () => 5 };
      await checkForUpdate(options);
      await writeFile(updateCachePath(configDir), "{not json");
      const result = await checkForUpdate(options);
      assert.equal(result.latestVersion, "0.2.0");
      assert.equal(mock.requests.length, 2);
    } finally {
      await mock.close();
    }
  });
});

test("GAHAR_NO_UPDATE_CHECK disables the background check without a request", async () => {
  assert.equal(updateCheckDisabled({ GAHAR_NO_UPDATE_CHECK: "1" }), true);
  assert.equal(updateCheckDisabled({ GAHAR_NO_UPDATE_CHECK: "off" }), false);
  assert.equal(updateCheckDisabled({}), false);
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error("must not be called");
  };
  const result = await checkForUpdate({
    ...BASE,
    env: { GAHAR_NO_UPDATE_CHECK: "true" },
    fetchImpl,
  });
  assert.equal(result, null);
  assert.equal(called, false);
});

test("failures resolve to null instead of throwing", async () => {
  const offline = async () => {
    throw new TypeError("fetch failed");
  };
  assert.equal(await checkForUpdate({ ...BASE, fetchImpl: offline }), null);
  const mock = await startMockGitHub({
    [`/repos/${REPO}/releases/latest`]: { status: 403, json: { message: "rate limited" } },
  });
  try {
    assert.equal(await checkForUpdate({ ...BASE, fetchImpl: mock.fetchImpl }), null);
    await assert.rejects(
      checkForUpdateOrThrow({ ...BASE, fetchImpl: mock.fetchImpl }),
      /rate limit/,
    );
  } finally {
    await mock.close();
  }
});

test("a malformed payload resolves to null and an explicit check explains it", async () => {
  const mock = await startMockGitHub({
    [`/repos/${REPO}/releases/latest`]: { body: "<html>oops</html>" },
  });
  try {
    assert.equal(await checkForUpdate({ ...BASE, fetchImpl: mock.fetchImpl }), null);
    await assert.rejects(
      checkForUpdateOrThrow({ ...BASE, fetchImpl: mock.fetchImpl }),
      /no valid version tag/,
    );
  } finally {
    await mock.close();
  }
});

test("a timed out request resolves to null", async () => {
  const hang = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  const started = Date.now();
  assert.equal(await checkForUpdate({ ...BASE, fetchImpl: hang, timeoutMs: 50 }), null);
  assert.ok(Date.now() - started < 2000);
  await assert.rejects(
    checkForUpdateOrThrow({ ...BASE, fetchImpl: hang, timeoutMs: 50 }),
    /timed out/,
  );
});
