import type {
  PerformUpdateOptions,
  PerformUpdateResult,
  UpdateCheckResult,
} from "../contracts/update.js";
import { GaharError, toErrorMessage } from "../shared/errors.js";
import { EXIT_ARG_ERROR } from "./args.js";
import type { CommandIO } from "./auth-cmd.js";

export interface UpdateDeps {
  check: () => Promise<UpdateCheckResult>;
  perform: (options: PerformUpdateOptions) => Promise<PerformUpdateResult>;
}

const UPDATE_FLAGS = new Set(["--check", "--force"]);

/** gahar update [--check] [--force] */
export async function runUpdate(
  args: readonly string[],
  deps: UpdateDeps,
  io: CommandIO,
): Promise<number> {
  const unknown = args.find((arg) => !UPDATE_FLAGS.has(arg));
  if (unknown !== undefined) {
    io.err(`unknown update option: ${unknown} (expected --check or --force)`);
    return EXIT_ARG_ERROR;
  }
  try {
    if (args.includes("--check")) {
      const result = await deps.check();
      io.out(`current: ${result.currentVersion}`);
      io.out(`latest:  ${result.latestVersion}`);
      io.out(
        result.updateAvailable
          ? `Update available. Run: gahar update (${result.releaseUrl})`
          : "You are on the latest version.",
      );
      return 0;
    }
    const result = await deps.perform({ force: args.includes("--force"), onLog: io.err });
    io.out(result.message);
    return 0;
  } catch (error) {
    io.err(toErrorMessage(error));
    return error instanceof GaharError ? error.exitCode : 1;
  }
}
