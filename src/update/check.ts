import { join } from "node:path";
import type { UpdateCheckOptions, UpdateCheckResult } from "../contracts/update.js";
import { GITHUB_REPO } from "../shared/defaults.js";
import { GaharError } from "../shared/errors.js";
import { atomicWriteFile, readTextFileIfExists } from "../shared/fsx.js";
import { VERSION } from "../shared/version.js";
import { httpGet, isTruthyEnv } from "./http.js";
import { isNewer, normalizeVersion, valid } from "./semver.js";

/** How long a cached update check stays usable. */
export const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_REQUEST_TIMEOUT_MS = 3000;

export interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
}

export interface UpdateSeams {
  fetchImpl?: typeof fetch;
  now?: () => number;
  currentVersion?: string;
  env?: NodeJS.ProcessEnv;
  configDir?: string;
}

export type CheckForUpdateOptions = UpdateCheckOptions & UpdateSeams;

interface CacheFile {
  version: 1;
  checkedAt: number;
  repo: string;
  result: UpdateCheckResult;
}

/** True when the user asked to skip update checks via GAHAR_NO_UPDATE_CHECK. */
export function updateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnv(env.GAHAR_NO_UPDATE_CHECK);
}

export function latestReleaseApiUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

/** Converts a raw GitHub payload into the UpdateCheckResult contract shape. */
export function toUpdateCheckResult(
  release: GitHubRelease,
  currentVersion: string,
  repo: string,
): UpdateCheckResult | null {
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  const latestVersion = normalizeVersion(tag);
  if (tag === "" || !valid(latestVersion)) return null;
  const releaseUrl =
    typeof release.html_url === "string" && release.html_url.length > 0
      ? release.html_url
      : `https://github.com/${repo}/releases/tag/${tag}`;
  const result: UpdateCheckResult = {
    currentVersion,
    latestVersion,
    updateAvailable: isNewer(latestVersion, currentVersion),
    releaseUrl,
    releaseNotesUrl: releaseUrl,
  };
  if (typeof release.published_at === "string" && release.published_at.length > 0) {
    result.publishedAt = release.published_at;
  }
  return result;
}

export function updateCachePath(configDir: string): string {
  return join(configDir, "cache", "update.json");
}

function isCheckResult(value: unknown): value is UpdateCheckResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<UpdateCheckResult>;
  return (
    typeof candidate.currentVersion === "string" &&
    typeof candidate.latestVersion === "string" &&
    typeof candidate.updateAvailable === "boolean" &&
    typeof candidate.releaseUrl === "string"
  );
}

async function readCache(
  configDir: string,
  repo: string,
  now: number,
): Promise<UpdateCheckResult | null> {
  const text = await readTextFileIfExists(updateCachePath(configDir)).catch(() => null);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as Partial<CacheFile>;
    if (parsed.version !== 1 || parsed.repo !== repo) return null;
    if (typeof parsed.checkedAt !== "number" || !isCheckResult(parsed.result)) return null;
    const age = now - parsed.checkedAt;
    if (age < 0 || age > UPDATE_CACHE_TTL_MS) return null;
    return parsed.result;
  } catch {
    return null;
  }
}

async function writeCache(
  configDir: string,
  repo: string,
  now: number,
  result: UpdateCheckResult,
): Promise<void> {
  const payload: CacheFile = { version: 1, checkedAt: now, repo, result };
  await atomicWriteFile(updateCachePath(configDir), `${JSON.stringify(payload, null, 2)}\n`);
}

function describeHttpFailure(status: number, repo: string): string {
  if (status === 404) return `no published release was found for ${repo} (HTTP 404)`;
  if (status === 403 || status === 429) {
    return `the GitHub API rate limit was reached (HTTP ${status}); try again later`;
  }
  return `the GitHub API answered HTTP ${status}`;
}

async function fetchLatestRelease(
  repo: string,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
  currentVersion: string,
): Promise<UpdateCheckResult> {
  const url = latestReleaseApiUrl(repo);
  const response = await httpGet(url, "application/vnd.github+json", timeoutMs, fetchImpl);
  if (!response.ok) {
    throw new GaharError(
      `Could not check for updates: ${describeHttpFailure(response.status, repo)}.`,
      {
        code: "update_check_failed",
      },
    );
  }
  const payload = (await response.json().catch(() => null)) as GitHubRelease | null;
  const result = payload === null ? null : toUpdateCheckResult(payload, currentVersion, repo);
  if (result === null) {
    throw new GaharError(`The latest release of ${repo} has no valid version tag.`, {
      code: "update_check_failed",
    });
  }
  return result;
}

/**
 * Resolves the latest release, using the 24h cache when allowed. Throws a
 * GaharError with the reason on failure. Ignores GAHAR_NO_UPDATE_CHECK, so an
 * explicit "gahar update" still works when background checks are disabled.
 */
export async function resolveLatestRelease(
  options: CheckForUpdateOptions = {},
): Promise<UpdateCheckResult> {
  const repo = options.repo ?? GITHUB_REPO;
  const currentVersion = options.currentVersion ?? VERSION;
  const now = options.now ?? Date.now;
  const { configDir } = options;
  if (options.allowCache !== false && configDir !== undefined) {
    const cached = await readCache(configDir, repo, now());
    if (cached !== null) {
      // The installed version may have changed since the cache was written.
      const updateAvailable = isNewer(cached.latestVersion, currentVersion);
      return { ...cached, currentVersion, updateAvailable };
    }
  }
  const timeoutMs = options.timeoutMs ?? UPDATE_REQUEST_TIMEOUT_MS;
  const result = await fetchLatestRelease(repo, timeoutMs, options.fetchImpl, currentVersion);
  if (configDir !== undefined) {
    await writeCache(configDir, repo, now(), result).catch(() => undefined);
  }
  return result;
}

/**
 * Background check for the startup notice. Never throws: being disabled,
 * offline, rate limited, timed out or receiving a malformed payload all give null.
 */
export async function checkForUpdate(
  options: CheckForUpdateOptions = {},
): Promise<UpdateCheckResult | null> {
  try {
    if (updateCheckDisabled(options.env ?? process.env)) return null;
    return await resolveLatestRelease(options);
  } catch {
    return null;
  }
}

/** For "gahar update --check": always queries GitHub and reports a failure as an error. */
export async function checkForUpdateOrThrow(
  options: CheckForUpdateOptions = {},
): Promise<UpdateCheckResult> {
  return resolveLatestRelease({ ...options, allowCache: options.allowCache ?? false });
}
