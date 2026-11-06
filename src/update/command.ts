import type { UpdateCheckResult } from "../contracts/update.js";
import { BINARY_NAME, GITHUB_RELEASES_URL } from "../shared/defaults.js";
import { toErrorMessage } from "../shared/errors.js";
import { type PerformUpdateSeams, performUpdate } from "./install.js";
import { isNewer } from "./semver.js";

export interface UpdateCommandIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export type UpdateCommandArgs =
  | { kind: "ok"; check: boolean; force: boolean }
  | { kind: "error"; message: string };

/** Parses the arguments of "gahar update [--check] [--force]". */
export function parseUpdateArgs(args: readonly string[]): UpdateCommandArgs {
  let check = false;
  let force = false;
  for (const arg of args) {
    if (arg === "--check") check = true;
    else if (arg === "--force") force = true;
    else return { kind: "error", message: `unknown argument for update: ${arg}` };
  }
  if (check && force) return { kind: "error", message: "--check and --force cannot be combined" };
  return { kind: "ok", check, force };
}

/** One-line startup notice for an available update, or null when up to date. */
export function formatUpdateNotice(result: UpdateCheckResult): string | null {
  if (!result.updateAvailable) return null;
  return `Update available: ${result.currentVersion} -> ${result.latestVersion}. Run: ${BINARY_NAME} update (${result.releaseUrl})`;
}

/**
 * Runs "gahar update". Progress goes to stdout; failures print the reason and
 * the manual install command to stderr. Returns the process exit code.
 */
export async function runUpdateCommand(
  args: readonly string[],
  io: UpdateCommandIo,
  seams: PerformUpdateSeams = {},
): Promise<number> {
  const parsed = parseUpdateArgs(args);
  if (parsed.kind === "error") {
    io.stderr(`${parsed.message}\nUsage: ${BINARY_NAME} update [--check] [--force]`);
    return 2;
  }
  try {
    const result = await performUpdate(
      { checkOnly: parsed.check, force: parsed.force, onLog: io.stdout },
      seams,
    );
    if (parsed.check && isNewer(result.latestVersion, result.currentVersion)) {
      io.stdout(`Release notes: ${GITHUB_RELEASES_URL}`);
    }
    return 0;
  } catch (error) {
    io.stderr(toErrorMessage(error));
    return 1;
  }
}
