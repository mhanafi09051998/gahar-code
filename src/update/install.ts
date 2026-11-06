import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PerformUpdateOptions, PerformUpdateResult } from "../contracts/update.js";
import { GITHUB_REPO, RELEASE_ASSET_NAME } from "../shared/defaults.js";
import { GaharError, toErrorMessage } from "../shared/errors.js";
import { VERSION } from "../shared/version.js";
import { checkForUpdate } from "./check.js";
import { isNewer, normalizeVersion, valid } from "./semver.js";

export { RELEASE_ASSET_NAME };

/** Manual fallback printed whenever an automated install cannot finish. */
export const MANUAL_INSTALL_COMMAND = `npm install -g https://github.com/${GITHUB_REPO}/releases/latest/download/${RELEASE_ASSET_NAME}`;

export interface SpawnOptionsLike {
  cwd?: string;
  stdio?: "inherit" | "pipe" | "ignore";
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  windowsHide?: boolean;
}

export interface SpawnResultLike {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
  signal?: NodeJS.Signals | null;
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: SpawnOptionsLike,
) => SpawnResultLike;

export interface PerformUpdateSeams {
  fetchImpl?: typeof fetch;
  spawnImpl?: SpawnLike;
  now?: () => number;
  currentVersion?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  npmCommand?: string;
  binPath?: string;
  tempRoot?: string;
  configDir?: string;
}

/** The real spawn seam, backed by spawnSync so the installer stays synchronous. */
export const defaultSpawn: SpawnLike = (command, args, options) => {
  const result = nodeSpawnSync(command, args, options as SpawnSyncOptions);
  return toSpawnResult(result);
};

function toSpawnResult(result: SpawnSyncReturns<string | Buffer>): SpawnResultLike {
  const toText = (value: string | Buffer | null | undefined): string =>
    typeof value === "string" ? value : (value?.toString() ?? "");
  const out: SpawnResultLike = {
    status: result.status ?? null,
    stdout: toText(result.stdout),
    stderr: toText(result.stderr),
    signal: result.signal ?? null,
  };
  if (result.error !== undefined) out.error = result.error;
  return out;
}

/** Resolves the release asset and checksum URLs for a repo and optional tag. */
export function releaseAssetUrl(repo: string, tag?: string): string {
  const base = `https://github.com/${repo}/releases`;
  if (tag === undefined || tag === "" || tag === "latest") {
    return `${base}/latest/download/${RELEASE_ASSET_NAME}`;
  }
  return `${base}/download/${tag}/${RELEASE_ASSET_NAME}`;
}

export function releaseChecksumUrl(repo: string, tag?: string): string {
  return `${releaseAssetUrl(repo, tag)}.sha256`;
}

/**
 * Strips a leading path plus ".exe" from an already resolved binary and
 * re-joins it, so Windows paths inside shim directories keep working.
 */
function logLine(options: PerformUpdateOptions, line: string): void {
  if (typeof options.onLog === "function") options.onLog(line);
}

/**
 * Picks the npm executable that should run the global install.
 * Uses the npm CLI that launched this process when it can find it, otherwise
 * falls back to the "npm" shim; on Windows the shim must run through cmd.exe.
 */
export function resolveNpmCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): { command: string; shell: boolean } {
  if (platform === "win32") {
    return { command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe", shell: false };
  }
  return { command: "npm", shell: false };
}

export function npmInstallArgs(tarballPath: string): string[] {
  return ["install", "-g", "--force", tarballPath];
}

/** Parses a sha256 sidecar file; accepts both hex and raw digest output. */
export function parseChecksumFile(text: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = /^([a-fA-F0-9]{64})(?:\s|$)/.exec(line);
    if (match?.[1] !== undefined) return match[1].toLowerCase();
  }
  return null;
}

export function computeSha256(buffer: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Parses "gahar 1.2.3" or "1.2.3" out of a --version output. */
export function parseVersionOutput(text: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/.exec(text);
  if (match?.[1] === undefined) return null;
  const version = normalizeVersion(match[1]);
  return valid(version) ? version : null;
}
function summarize(stderr: string | null | undefined, fallback: string): string {
  const text = (stderr ?? "").trim();
  if (text === "") return fallback;
  return text.split(/\r?\n/).slice(-3).join(" ").slice(0, 400);
}

async function downloadToFile(
  url: string,
  filePath: string,
  seams: PerformUpdateSeams,
  timeoutMs: number,
): Promise<void> {
  const doFetch = seams.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new GaharError("No fetch implementation is available in this Node.js runtime.", {
      code: "update_failed",
    });
  }
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  const response = await doFetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { "User-Agent": "gahar-code-cli", Accept: "application/octet-stream" },
    signal,
  });
  if (!response.ok) {
    throw new GaharError(`Download failed with HTTP ${response.status} for ${url}`, {
      code: "update_failed",
    });
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) {
    throw new GaharError(`Downloaded an empty file from ${url}`, { code: "update_failed" });
  }
  await writeFile(filePath, buffer);
}


/** Runs the global npm install of the downloaded tarball. */
export function runNpmInstall(
  tarballPath: string,
  seams: PerformUpdateSeams,
  options: PerformUpdateOptions,
): void {
  const spawn = seams.spawnImpl ?? defaultSpawn;
  const { command } = resolveNpmCommand(seams.env ?? process.env, seams.platform);
  const args = npmInstallArgs(tarballPath);
  logLine(options, `Installing with: npm ${args.join(" ")}`);
  const result = spawn(command, args, { stdio: "inherit", windowsHide: true });
  if (result.error !== undefined) {
    throw new GaharError(
      `Could not run npm. Install manually: ${MANUAL_INSTALL_COMMAND}`,
      { code: "update_failed", cause: result.error },
    );
  }
  if (result.status !== 0) {
    const detail = summarize(result.stderr, `npm exited with code ${result.status ?? "unknown"}`);
    throw new GaharError(
      `npm install failed (${detail}). Install manually: ${MANUAL_INSTALL_COMMAND}`,
      { code: "update_failed" },
    );
  }
}

/** Verifies the freshly installed version by asking the binary for --version. */
export function verifyInstalledVersion(
  expectedVersion: string,
  seams: PerformUpdateSeams,
  options: PerformUpdateOptions,
): void {
  const spawn = seams.spawnImpl ?? defaultSpawn;
  const env = seams.env ?? process.env;
  const platform = seams.platform ?? process.platform;
  const binPath = seams.binPath;
  const localPrefix = env.npm_config_prefix ?? env.PREFIX;
  const base = binPath ?? (localPrefix !== undefined
    ? join(localPrefix, platform === "win32" ? "gahar.cmd" : "bin/gahar")
    : "gahar");
  const invocations: Array<[string, string[]]> = platform === "win32"
    ? [[env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${base}" --version`]]]
    : [[base, ["--version"]]];
  for (const [command, args] of invocations) {
    logLine(options, `Verifying installed version with: ${command} ${args.join(" ")}`);
    const result = spawn(command, args, { stdio: "pipe", windowsHide: true });
    if (result.error !== undefined || result.status !== 0) continue;
    const parsed = parseVersionOutput(String(result.stdout ?? ""));
    if (parsed === null) continue;
    if (parsed === normalizeVersion(expectedVersion)) return;
    throw new GaharError(
      `The installed binary reports v${parsed} but v${expectedVersion} was expected. ` +
        `Reinstall manually: ${MANUAL_INSTALL_COMMAND}`,
      { code: "update_failed" },
    );
  }
  throw new GaharError(
    `Installed v${expectedVersion} but could not confirm it with "gahar --version". ` +
      `Open a new terminal, or verify with: gahar --version. Manual install: ${MANUAL_INSTALL_COMMAND}`,
    { code: "update_failed" },
  );
}
/**
 * Performs a full update: resolve, download, verify the sha256 checksum, install
 * globally with npm, then confirm the installed version. All failure paths throw
 * a GaharError whose message names the manual install command.
 */
export async function performUpdate(
  options: PerformUpdateOptions = {},
  deps: PerformUpdateSeams = {},
): Promise<PerformUpdateResult> {
  const env = deps.env ?? process.env;
  const currentVersion = deps.currentVersion ?? VERSION;
  const repo = GITHUB_REPO;
  const checkOptions: Parameters<typeof checkForUpdate>[0] = {
    repo,
    env,
    currentVersion,
    allowCache: options.checkOnly === true,
  };
  if (deps.fetchImpl !== undefined) checkOptions.fetchImpl = deps.fetchImpl;
  if (deps.now !== undefined) checkOptions.now = deps.now;
  if (deps.platform !== undefined) checkOptions.platform = deps.platform;
  if (deps.configDir !== undefined) checkOptions.configDir = deps.configDir;

  logLine(options, `Checking ${repo} for a newer release...`);
  const check = await checkForUpdate(checkOptions);
  if (check === null) {
    throw new GaharError(
      `Could not resolve the latest release of ${repo}. Check your network connection, then retry or install manually: ${MANUAL_INSTALL_COMMAND}`,
      { code: "update_failed" },
    );
  }
  const latestVersion = check.latestVersion;
  if (options.checkOnly === true) {
    const suffix = check.updateAvailable
      ? `Update available: v${currentVersion} -> v${latestVersion}. Run: gahar update`
      : `Gahar Code is up to date (v${currentVersion}).`;
    logLine(options, suffix);
    return { updated: false, currentVersion, latestVersion, message: suffix };
  }
  if (!options.force && !isNewer(latestVersion, currentVersion)) {
    const message = `Gahar Code is already up to date (v${currentVersion}).`;
    logLine(options, message);
    return { updated: false, currentVersion, latestVersion, message };
  }

  const assetUrl = `https://github.com/${repo}/releases/download/v${latestVersion}/${RELEASE_ASSET_NAME}`;
  const checksumUrl = `${assetUrl}.sha256`;
  logLine(options, `Downloading v${latestVersion} from ${assetUrl}`);

  const tempRoot = deps.tempRoot ?? tmpdir();
  let workDir: string | null = null;
  try {
    workDir = await mkdtemp(join(tempRoot, "gahar-update-"));
    const tarballPath = join(workDir, RELEASE_ASSET_NAME);
    const checksumPath = `${tarballPath}.sha256`;
    const timeoutMs = 60_000;
    await downloadToFile(assetUrl, tarballPath, deps, timeoutMs);
    await downloadToFile(checksumUrl, checksumPath, deps, timeoutMs);

    const tarball = await readFile(tarballPath);
    const actual = computeSha256(tarball);
    const expected = parseChecksumFile(await readFile(checksumPath, "utf8"));
    if (expected === null) {
      throw new GaharError(
        `Could not read a valid sha256 checksum from ${checksumUrl}. Refusing to install. ` +
          `Install manually: ${MANUAL_INSTALL_COMMAND}`,
        { code: "update_failed" },
      );
    }
    if (actual !== expected) {
      throw new GaharError(
        `Checksum mismatch for ${RELEASE_ASSET_NAME}: expected ${expected}, got ${actual}. ` +
          "Refusing to install. Download manually from the Releases page if you trust the source.",
        { code: "update_failed" },
      );
    }
    logLine(options, "Checksum verified.");

    runNpmInstall(tarballPath, deps, options);
    verifyInstalledVersion(latestVersion, deps, options);

    const message = `Updated Gahar Code v${currentVersion} -> v${latestVersion}.`;
    logLine(options, message);
    return { updated: true, currentVersion, latestVersion, message };
  } catch (error) {
    if (error instanceof GaharError) throw error;
    throw new GaharError(
      `Update failed: ${toErrorMessage(error)}. Install manually: ${MANUAL_INSTALL_COMMAND}`,
      { code: "update_failed", cause: error },
    );
  } finally {
    if (workDir !== null) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}