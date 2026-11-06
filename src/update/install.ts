import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PerformUpdateOptions, PerformUpdateResult } from "../contracts/update.js";
import { GITHUB_REPO, RELEASE_ASSET_NAME } from "../shared/defaults.js";
import { GaharError, toErrorMessage } from "../shared/errors.js";
import { VERSION } from "../shared/version.js";
import { resolveLatestRelease, type UpdateSeams } from "./check.js";
import { httpGet } from "./http.js";
import {
  currentNpmEnvironment,
  defaultSpawn,
  type NpmEnvironment,
  npmInstallArgs,
  npmInvocation,
  runInvocation,
  type SpawnLike,
  summarizeStderr,
  updateFailed,
} from "./npm.js";
import { isNewer } from "./semver.js";
import { verifyInstalledVersion } from "./verify.js";

export const DOWNLOAD_TIMEOUT_MS = 60_000;

export interface PerformUpdateSeams extends Omit<UpdateSeams, "configDir"> {
  repo?: string;
  configDir?: string;
  spawnImpl?: SpawnLike;
  npm?: Partial<NpmEnvironment>;
  tempRoot?: string;
}

/** URL of the release tarball for a tag, or for the latest release. */
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

/** Reads the digest from a sha256sum-style sidecar ("<hex>  gahar-code.tgz"). */
export function parseChecksumFile(text: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})(?:\s|$)/.exec(rawLine.trim());
    if (match?.[1] !== undefined) return match[1].toLowerCase();
  }
  return null;
}

export function computeSha256(data: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function download(url: string, fetchImpl: typeof fetch | undefined): Promise<Buffer> {
  const response = await httpGet(url, "application/octet-stream", DOWNLOAD_TIMEOUT_MS, fetchImpl);
  if (!response.ok) throw updateFailed(`Download failed with HTTP ${response.status} for ${url}.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) throw updateFailed(`Downloaded an empty file from ${url}.`);
  return buffer;
}

/** Downloads the tarball and its checksum, refusing anything that does not match. */
async function downloadVerifiedTarball(
  repo: string,
  tag: string,
  fetchImpl: typeof fetch | undefined,
): Promise<Buffer> {
  const checksumUrl = releaseChecksumUrl(repo, tag);
  const tarball = await download(releaseAssetUrl(repo, tag), fetchImpl);
  const expected = parseChecksumFile((await download(checksumUrl, fetchImpl)).toString("utf8"));
  if (expected === null) {
    throw updateFailed(
      `Could not read a valid sha256 checksum from ${checksumUrl}. Refusing to install.`,
    );
  }
  const actual = computeSha256(tarball);
  if (actual !== expected) {
    throw updateFailed(
      `Checksum mismatch for ${RELEASE_ASSET_NAME}: expected ${expected}, got ${actual}. Refusing to install.`,
    );
  }
  return tarball;
}

/** Runs "npm install -g --force <tarball>" with inherited stdio. */
export function runNpmInstall(
  tarballPath: string,
  spawn: SpawnLike,
  npm: NpmEnvironment,
  log: (line: string) => void,
): void {
  const args = npmInstallArgs(tarballPath);
  log(`Installing with: npm ${args.join(" ")}`);
  const result = runInvocation(spawn, npmInvocation(args, npm), "inherit");
  if (result.error !== undefined) {
    throw updateFailed(`Could not run npm (${result.error.message}).`, result.error);
  }
  if (result.status !== 0) {
    const detail = summarizeStderr(
      result.stderr,
      `npm exited with code ${result.status ?? "unknown"}`,
    );
    throw updateFailed(`npm install failed (${detail}).`);
  }
}

/**
 * Full update: resolve the latest release, download it, verify the sha256
 * checksum, install it globally with npm, then confirm the installed version.
 * Every failure throws a GaharError that names the manual install command.
 */
export async function performUpdate(
  options: PerformUpdateOptions = {},
  seams: PerformUpdateSeams = {},
): Promise<PerformUpdateResult> {
  const log = (line: string): void => options.onLog?.(line);
  const repo = seams.repo ?? GITHUB_REPO;
  const currentVersion = seams.currentVersion ?? VERSION;
  log(`Checking ${repo} for a newer release...`);
  let latestVersion: string;
  try {
    const check = await resolveLatestRelease({ ...seams, repo, currentVersion, allowCache: false });
    latestVersion = check.latestVersion;
  } catch (error) {
    throw updateFailed(`${toErrorMessage(error)} Check your network connection and retry.`, error);
  }

  if (
    options.checkOnly === true ||
    (options.force !== true && !isNewer(latestVersion, currentVersion))
  ) {
    const message = isNewer(latestVersion, currentVersion)
      ? `Update available: v${currentVersion} -> v${latestVersion}. Run: gahar update`
      : `Gahar Code is already up to date (v${currentVersion}).`;
    log(message);
    return { updated: false, currentVersion, latestVersion, message };
  }

  const npm: NpmEnvironment = { ...currentNpmEnvironment(), ...seams.npm };
  const spawn = seams.spawnImpl ?? defaultSpawn;
  const tag = `v${latestVersion}`;
  let workDir: string | null = null;
  try {
    log(`Downloading ${tag} from ${releaseAssetUrl(repo, tag)}`);
    const tarball = await downloadVerifiedTarball(repo, tag, seams.fetchImpl);
    log("Checksum verified.");
    workDir = await mkdtemp(join(seams.tempRoot ?? tmpdir(), "gahar-update-"));
    const tarballPath = join(workDir, RELEASE_ASSET_NAME);
    await writeFile(tarballPath, tarball);
    runNpmInstall(tarballPath, spawn, npm, log);
    verifyInstalledVersion(latestVersion, spawn, npm, log);
  } catch (error) {
    if (error instanceof GaharError) throw error;
    throw updateFailed(`Update failed: ${toErrorMessage(error)}.`, error);
  } finally {
    if (workDir !== null)
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
  const message = `Updated Gahar Code v${currentVersion} -> v${latestVersion}.`;
  log(message);
  return { updated: true, currentVersion, latestVersion, message };
}
