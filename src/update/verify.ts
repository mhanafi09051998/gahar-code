import { join } from "node:path";
import { BINARY_NAME } from "../shared/defaults.js";
import {
  type Invocation,
  type NpmEnvironment,
  npmInvocation,
  runInvocation,
  type SpawnLike,
  updateFailed,
  viaCmd,
} from "./npm.js";
import { normalizeVersion, valid } from "./semver.js";

export const PACKAGE_NAME = "gahar-code";

/** Parses "gahar 1.2.3" or "1.2.3" out of --version output. */
export function parseVersionOutput(text: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/.exec(text);
  if (match?.[1] === undefined) return null;
  const version = normalizeVersion(match[1]);
  return valid(version) ? version : null;
}

/** The global npm root ("npm root -g"), or null when npm cannot report it. */
export function globalNpmRoot(spawn: SpawnLike, npm: NpmEnvironment): string | null {
  const result = runInvocation(spawn, npmInvocation(["root", "-g"], npm), "pipe");
  if (result.error !== undefined || result.status !== 0) return null;
  const root =
    String(result.stdout ?? "")
      .trim()
      .split(/\r?\n/)
      .pop() ?? "";
  return root === "" ? null : root;
}

/**
 * Ways to ask the installed CLI for its version, most precise first: the
 * package entry inside the global npm root, run with this Node.js binary, then
 * the "gahar" shim found on PATH.
 */
export function versionInvocations(spawn: SpawnLike, npm: NpmEnvironment): Invocation[] {
  const invocations: Invocation[] = [];
  const root = globalNpmRoot(spawn, npm);
  if (root !== null) {
    const entry = join(root, PACKAGE_NAME, "dist", "cli.js");
    if (npm.fileExists(entry))
      invocations.push({ command: npm.execPath, args: [entry, "--version"] });
  }
  invocations.push(
    npm.platform === "win32"
      ? viaCmd(npm.env, `${BINARY_NAME} --version`)
      : { command: BINARY_NAME, args: ["--version"] },
  );
  return invocations;
}

/** Confirms the installed binary reports the expected version, or throws. */
export function verifyInstalledVersion(
  expectedVersion: string,
  spawn: SpawnLike,
  npm: NpmEnvironment,
  log: (line: string) => void,
): void {
  const expected = normalizeVersion(expectedVersion);
  for (const invocation of versionInvocations(spawn, npm)) {
    log(`Verifying installed version with: ${invocation.command} ${invocation.args.join(" ")}`);
    const result = runInvocation(spawn, invocation, "pipe");
    if (result.error !== undefined || result.status !== 0) continue;
    const reported = parseVersionOutput(String(result.stdout ?? ""));
    if (reported === null) continue;
    if (reported === expected) return;
    throw updateFailed(`The installed binary reports v${reported} but v${expected} was expected.`);
  }
  throw updateFailed(
    `Installed v${expected} but could not confirm it with "${BINARY_NAME} --version". ` +
      "Open a new terminal and run it to check.",
  );
}
