import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RELEASE_ASSET_NAME } from "../../../dist/shared/defaults.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path) => readFile(`${root}${path}`, "utf8");

test("release workflow publishes the asset names the updater downloads", async () => {
  const release = await read(".github/workflows/release.yml");
  assert.equal(RELEASE_ASSET_NAME, "gahar-code.tgz");
  assert.match(release, /contents: write/);
  assert.match(release, /mv "\$TARBALL" gahar-code\.tgz/);
  assert.match(release, /sha256sum gahar-code\.tgz > gahar-code\.tgz\.sha256/);
  assert.match(release, /gahar-code\.tgz gahar-code\.tgz\.sha256/);
  assert.match(release, /tags: \["v\*\.\*\.\*"\]/);
  assert.doesNotMatch(release, /secrets\./, "the release must not need repository secrets");
});

test("CI runs the secret scan and the full check on every OS", async () => {
  const ci = await read(".github/workflows/ci.yml");
  for (const needle of [
    "npm ci",
    "npm run secret-scan",
    "npm test",
    "windows-latest",
    "ubuntu-latest",
  ]) {
    assert.ok(ci.includes(needle), needle);
  }
});
