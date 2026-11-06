import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, eq, gt, isNewer, max, parse, valid } from "../../../dist/update/semver.js";

test("parse reads core, prerelease and build parts, accepting a v prefix", () => {
  const parsed = parse("v1.2.3-beta.1+sha.5");
  assert.equal(parsed.major, 1);
  assert.equal(parsed.minor, 2);
  assert.equal(parsed.patch, 3);
  assert.deepEqual(parsed.prerelease, ["beta", "1"]);
  assert.deepEqual(parsed.build, ["sha", "5"]);
});

test("valid rejects malformed versions and leading zeros", () => {
  for (const bad of ["", "1.2", "1.2.3.4", "01.2.3", "abc", null, undefined]) {
    assert.equal(valid(bad), false, String(bad));
  }
  assert.equal(valid("0.1.0"), true);
});

test("compare orders major, minor and patch numerically", () => {
  assert.ok(compare("1.10.0", "1.9.9") > 0);
  assert.ok(compare("0.1.0", "0.2.0") < 0);
  assert.equal(compare("2.0.0", "v2.0.0"), 0);
});

test("prerelease ordering follows semver precedence", () => {
  const ordered = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ];
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(gt(ordered[index], ordered[index - 1]), `${ordered[index]} > ${ordered[index - 1]}`);
  }
});

test("build metadata is ignored for precedence", () => {
  assert.equal(eq("1.0.0+a", "1.0.0+b"), true);
  assert.equal(isNewer("1.0.0+b", "1.0.0+a"), false);
});

test("isNewer is false for invalid input and max skips invalid entries", () => {
  assert.equal(isNewer("garbage", "1.0.0"), false);
  assert.equal(isNewer("1.0.1", "garbage"), false);
  assert.equal(isNewer("0.2.0", "0.1.0"), true);
  assert.equal(max(["0.1.0", "bad", "v0.3.0-rc.1", "0.2.5"]), "0.3.0-rc.1");
  assert.equal(max([]), null);
});
