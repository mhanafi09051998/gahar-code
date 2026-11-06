/**
 * Minimal semver parsing and comparison.
 *
 * Supports the subset used by Gahar Code releases: MAJOR.MINOR.PATCH with an
 * optional prerelease and optional build metadata, following semver.org 2.0.0
 * precedence rules. Build metadata is ignored when comparing versions.
 */

export interface SemverVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
  raw: string;
}

const VERSION_PATTERN =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<pre>[0-9A-Za-z.-]+))?(?:\+(?<build>[0-9A-Za-z.-]+))?$/;

/** Removes a leading "v" and surrounding whitespace: "v1.2.3" -> "1.2.3". */
export function normalizeVersion(input: string): string {
  return input.trim().replace(/^[vV]/, "");
}

/** Parses a version string, or returns null when it is not valid semver. */
export function parse(input: string | null | undefined): SemverVersion | null {
  if (typeof input !== "string") return null;
  const raw = normalizeVersion(input);
  const match = VERSION_PATTERN.exec(raw);
  if (!match?.groups) return null;
  const { major, minor, patch, pre, build } = match.groups;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: pre === undefined || pre === "" ? [] : pre.split("."),
    build: build === undefined || build === "" ? [] : build.split("."),
    raw,
  };
}

/** True when the string is a valid semver version. */
export function valid(input: string | null | undefined): boolean {
  return parse(input) !== null;
}

function comparePrereleaseIdentifiers(a: string[], b: string[]): number {
  // A version without prerelease has higher precedence than one with it.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const delta = Number(left) - Number(right);
      if (delta !== 0) return delta < 0 ? -1 : 1;
      continue;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Compares two versions: negative when a < b, 0 when equal, positive when a > b.
 * Invalid versions are ordered last and never throw.
 */
export function compare(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return comparePrereleaseIdentifiers(left.prerelease, right.prerelease);
}

/** True when a has strictly higher precedence than b. */
export function gt(a: string, b: string): boolean {
  return compare(a, b) > 0;
}

/** True when both versions are valid and equal in precedence. */
export function eq(a: string, b: string): boolean {
  return parse(a) !== null && parse(b) !== null && compare(a, b) === 0;
}

/** True when candidate is a valid version strictly newer than current. */
export function isNewer(candidate: string, current: string): boolean {
  if (!valid(candidate) || !valid(current)) return false;
  return gt(candidate, current);
}

/** The highest version of the list, ignoring invalid entries. */
export function max(versions: readonly string[]): string | null {
  let best: string | null = null;
  for (const version of versions) {
    if (!valid(version)) continue;
    if (best === null || gt(version, best)) best = normalizeVersion(version);
  }
  return best;
}
