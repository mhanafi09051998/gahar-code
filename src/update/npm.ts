import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { GITHUB_REPO, RELEASE_ASSET_NAME } from "../shared/defaults.js";
import { GaharError } from "../shared/errors.js";

/** Manual fallback printed whenever an automated install cannot finish. */
export const MANUAL_INSTALL_COMMAND = `npm install -g https://github.com/${GITHUB_REPO}/releases/latest/download/${RELEASE_ASSET_NAME}`;

/** An update failure whose message always ends with the manual install command. */
export function updateFailed(message: string, cause?: unknown): GaharError {
  return new GaharError(`${message} Install manually: ${MANUAL_INSTALL_COMMAND}`, {
    code: "update_failed",
    cause,
  });
}

export interface SpawnOptionsLike {
  stdio: "inherit" | "pipe";
  windowsHide?: boolean;
  windowsVerbatimArguments?: boolean;
}

export interface SpawnResultLike {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: SpawnOptionsLike,
) => SpawnResultLike;

/** Process facts used to locate npm; injectable so tests cover every platform. */
export interface NpmEnvironment {
  env: NodeJS.ProcessEnv;
  platform: string;
  execPath: string;
  fileExists: (path: string) => boolean;
}

export interface Invocation {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/** The real spawn seam, backed by spawnSync so the installer stays sequential. */
export const defaultSpawn: SpawnLike = (command, args, options) => {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" } as SpawnSyncOptions);
  const out: SpawnResultLike = {
    status: result.status,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
  if (result.error !== undefined) out.error = result.error;
  return out;
};

export function currentNpmEnvironment(): NpmEnvironment {
  return {
    env: process.env,
    platform: process.platform,
    execPath: process.execPath,
    fileExists: existsSync,
  };
}

export function npmInstallArgs(tarballPath: string): string[] {
  return ["install", "-g", "--force", tarballPath];
}

/** Quotes one argument for cmd.exe; temp paths may contain spaces. */
export function quoteForCmd(arg: string): string {
  return /[\s"&|<>^()%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/** Runs a command line through cmd.exe so .cmd shims resolve from PATH. */
export function viaCmd(env: NodeJS.ProcessEnv, commandLine: string): Invocation {
  return {
    command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

/** Finds npm-cli.js so npm runs under the same Node.js binary as the CLI. */
export function findNpmCli(npm: NpmEnvironment): string | null {
  const fromEnv = npm.env.npm_execpath;
  if (fromEnv !== undefined && /npm-cli\.js$/i.test(fromEnv) && npm.fileExists(fromEnv)) {
    return fromEnv;
  }
  const nodeDir = dirname(npm.execPath);
  const candidates =
    npm.platform === "win32"
      ? [join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js")]
      : [join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  return candidates.find((candidate) => npm.fileExists(candidate)) ?? null;
}

/**
 * Builds the invocation for "npm <args>". Prefers node + npm-cli.js (no shell,
 * no quoting issues); otherwise "npm" from PATH, through cmd.exe on Windows
 * because Node refuses to spawn .cmd shims directly.
 */
export function npmInvocation(args: string[], npm: NpmEnvironment): Invocation {
  const npmCli = findNpmCli(npm);
  if (npmCli !== null) return { command: npm.execPath, args: [npmCli, ...args] };
  if (npm.platform === "win32") return viaCmd(npm.env, ["npm", ...args].map(quoteForCmd).join(" "));
  return { command: "npm", args };
}

export function runInvocation(
  spawn: SpawnLike,
  invocation: Invocation,
  stdio: SpawnOptionsLike["stdio"],
): SpawnResultLike {
  const options: SpawnOptionsLike = { stdio, windowsHide: true };
  if (invocation.windowsVerbatimArguments === true) options.windowsVerbatimArguments = true;
  return spawn(invocation.command, invocation.args, options);
}

/** Last lines of stderr, or the fallback when npm printed nothing. */
export function summarizeStderr(stderr: string | null | undefined, fallback: string): string {
  const text = (stderr ?? "").trim();
  if (text === "") return fallback;
  return text.split(/\r?\n/).slice(-3).join(" ").slice(0, 400);
}
