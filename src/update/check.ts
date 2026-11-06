import { join } from "node:path";
import type { UpdateCheckOptions, UpdateCheckResult } from "../contracts/update.js";
import { GITHUB_REPO, GITHUB_RELEASES_URL } from "../shared/defaults.js";
import { GaharError, isAbortError, toErrorMessage } from "../shared/errors.js";
import { atomicWriteFile, readTextFileIfExists } from "../shared/fsx.js";
import { VERSION } from "../shared/version.js";
import { isNewer, normalizeVersion, valid } from "./semver.js";

/** How long a cached update check stays usable. */
export const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_REQUEST_TIMEOUT_MS = 3000;
export const UPDATE_USER_AGENT = "gahar-code-cli";

export interface GitHubReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
}

export interface GitHubRelease {
  tag_name?: unknown;
  name?: unknown;
  html_url?: unknown;
  body?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
}

export interface UpdateSeams {
  fetchImpl?: typeof fetch;
  now?: () => number;
  currentVersion?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
}

interface CacheFile {
  version: 1;
  checkedAt: number;
  repo: string;
  result: UpdateCheckResult;
}

const UPDATE_DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

/** True when the user asked to skip update checks via GAHAR_NO_UPDATE_CHECK. */
export function updateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GAHAR_NO_UPDATE_CHECK;
  if (raw === undefined) return false;
  return !UPDATE_DISABLED_VALUES.has(raw.trim().toLowerCase());
}

/** Resolves a fetch implementation plus an AbortSignal that works on Node 18+. */
function resolveTransport(
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
): { doFetch: typeof fetch; signal: AbortSignal | undefined } {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return { doFetch, signal: AbortSignal.timeout(timeoutMs) };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return { doFetch, signal: controller.signal };
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
      : `${GITHUB_RELEASES_URL}/tag/${tag}`;
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
    if (typeof parsed.checkedAt !== "number") return null;
    if (!isCheckResult(parsed.result)) return null;
    if (now - parsed.checkedAt > UPDATE_CACHE_TTL_MS) return null;
    if (now - parsed.checkedAt < 0) return null;
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

async function fetchLatestRelease(
  repo: string,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
  currentVersion: string,
): Promise<UpdateCheckResult | null> {
  const { doFetch, signal } = resolveTransport(timeoutMs, fetchImpl);
  if (typeof doFetch !== "function") return null;
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const response = await doFetch(url, {
    method: "GET",
    // Unauthenticated on purpose: the repository is public and Gahar Code never
    // stores or transmits a GitHub token.
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": UPDATE_USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal,
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as GitHubRelease;
  return toUpdateCheckResult(payload, currentVersion, repo);
}

/**
 * Checks GitHub for a newer release. Never throws: any failure (offline, rate
 * limit, timeout, malformed payload) resolves to null so the CLI cannot crash.
 */
export async function checkForUpdate(
  options: UpdateCheckOptions & UpdateSeams & { configDir?: string } = {},
): Promise<UpdateCheckResult | null> {
  try {
    const env = options.env ?? process.env;
    if (updateCheckDisabled(env)) return null;
    const repo = options.repo ?? GITHUB_REPO;
    const timeoutMs = options.timeoutMs ?? UPDATE_REQUEST_TIMEOUT_MS;
    const currentVersion = options.currentVersion ?? VERSION;
    const now = options.now ?? Date.now;
    const configDir = options.configDir;
    const allowCache = options.allowCache !== false;
    if (allowCache && configDir !== undefined) {
      const cached = await readCache(configDir, repo, now());
      if (cached !== null) return { ...cached, currentVersion };
    }
    const fresh = await fetchLatestRelease(repo, timeoutMs, options.fetchImpl, currentVersion);
    if (fresh === null) return null;
    const result = fresh;
    if (configDir !== undefined) {
      await writeCache(configDir, repo, now(), result).catch(() => undefined);
    }
    return result;
  } catch {
    return null;
  }
}

/** Same as checkForUpdate, but raises a readable error for "gahar update --check". */
export async function checkForUpdateOrThrow(
  options: UpdateCheckOptions & UpdateSeams & { configDir?: string } = {},
): Promise<UpdateCheckResult> {
  const env = options.env ?? process.env;
  if (updateCheckDisabled(env)) {
    throw new GaharError(
      "Update checks are disabled by GAHAR_NO_UPDATE_CHECK. Unset it and run: gahar update --check",
      { code: "update_check_disabled" },
    );
  }
  const result = await checkForUpdate(options);
  if (result === null) {
    throw new GaharError(
      `Could not reach the GitHub releases API for ${options.repo ?? GITHUB_REPO}. ` +
        "Check your network connection and retry: gahar update --check",
      { code: "update_check_failed" },
    );
  }
  return result;
}

export function describeCheckFailure(error: unknown): string {
  if (isAbortError(error)) return "the request timed out";
  return toErrorMessage(error);
}
