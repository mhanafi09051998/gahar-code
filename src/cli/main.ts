import type { App, AppOptions } from "../contracts/runner.js";
import { toErrorMessage } from "../shared/errors.js";
import { createApprovalHandler } from "../ui/approval.js";
import { createLineEditor } from "../ui/prompt.js";
import { runRepl } from "../ui/repl.js";
import { notifyUpdate } from "../ui/update-notifier.js";
import {
  type CliOptions,
  EXIT_ARG_ERROR,
  EXIT_AUTH_ERROR,
  EXIT_INTERRUPT,
  helpText,
  parseArgs,
  versionText,
} from "./args.js";
import { type CliEnv, createEnv, isJsonMode, noColor, type PartialCliEnv } from "./env.js";
import { failureExitCode, runHeadless } from "./headless.js";
import { JsonEventWriter } from "./json-output.js";
import { loadCliConfig, runSubcommand } from "./subcommands.js";

export type SignalInstaller = (abort: () => void) => () => void;

export interface CliDeps {
  createApp: (options: AppOptions) => Promise<App>;
  env?: PartialCliEnv;
  installSignals?: SignalInstaller;
}

const NO_KEY_MESSAGE =
  "No OpenRouter API key configured. Set OPENROUTER_API_KEY or run: gahar auth login";

/** SIGINT/SIGTERM abort the running turn; a second signal exits with 130. */
export const processSignals: SignalInstaller = (abort) => {
  let received = 0;
  const onSignal = (): void => {
    received += 1;
    if (received > 1) process.exit(EXIT_INTERRUPT);
    abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
};

/** Parses argv and dispatches to help/version, a subcommand, headless or the REPL. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const env = createEnv({ ...deps.env, argv });
  try {
    const parsed = parseArgs(argv);
    switch (parsed.kind) {
      case "help":
        env.stdout.write(`${helpText()}\n`);
        return 0;
      case "version":
        env.stdout.write(`${versionText()}\n`);
        return 0;
      case "error":
        env.stderr.write(`error: ${parsed.message}\n`);
        return EXIT_ARG_ERROR;
      case "command":
        return await runSubcommand(parsed.name, parsed.args, parsed.options, env);
      case "run":
        return await runSession(parsed.prompt, parsed.options, env, deps);
    }
  } catch (error) {
    env.stderr.write(`error: ${toErrorMessage(error)}\n`);
    return failureExitCode(error);
  }
}

async function runSession(
  argPrompt: string | null,
  options: CliOptions,
  env: CliEnv,
  deps: CliDeps,
): Promise<number> {
  const json = isJsonMode(env, options.json);
  const interactive = argPrompt === null && env.isTTY && !json;
  let loaded = await loadCliConfig(options, env);
  if (loaded.config.apiKey === null && interactive) {
    const code = await runSubcommand("setup", [], options, env);
    if (code !== 0) return code;
    loaded = await loadCliConfig(options, env);
  }
  if (loaded.config.apiKey === null) return reportError(env, json, NO_KEY_MESSAGE, EXIT_AUTH_ERROR);

  const resume =
    options.resume !== undefined
      ? { type: "id" as const, id: options.resume }
      : options.continue
        ? { type: "latest" as const }
        : undefined;
  const base = { config: loaded.config, ...(resume === undefined ? {} : { resume }) };
  const color = !json && !noColor(env, options.noColor) && !loaded.config.noColor;
  const installSignals = deps.installSignals ?? processSignals;

  if (interactive) {
    if (!options.noUpdateCheck && loaded.config.updateCheck) {
      void notifyUpdate({
        stderr: env.stderr,
        configDir: env.configDir,
        enabled: true,
        env: env.env,
      });
    }
    const outcome = await runRepl({
      cwd: loaded.config.cwd,
      configDir: loaded.config.configDir,
      stderr: env.stderr,
      color,
      columns: env.columns,
      quiet: options.quiet,
      envKey: loaded.config.apiKeySource === "env",
      createApp: deps.createApp,
      appOptions: base,
      installSignals,
    });
    return outcome.exitCode;
  }

  const prompt = argPrompt ?? (await readStdinPrompt(env));
  if (prompt === null) {
    return reportError(env, json, 'no prompt given. Use: gahar -p "<prompt>"', EXIT_ARG_ERROR);
  }
  const approvals = createApprovalHandler({
    stderr: env.stderr,
    interactive: argPrompt !== null && env.stdinIsTTY && !json,
    json,
  });
  const outcome = await runHeadless({
    prompt,
    cwd: loaded.config.cwd,
    json,
    color,
    columns: env.columns,
    stdout: env.stdout,
    stderr: env.stderr,
    createApp: deps.createApp,
    appOptions: { ...base, approvals },
    installSignals,
  });
  return outcome.exitCode;
}

/** Reads the whole of a piped stdin as the prompt; null when stdin is a TTY or empty. */
async function readStdinPrompt(env: CliEnv): Promise<string | null> {
  if (env.stdinIsTTY) return null;
  const result = await createLineEditor({ configDir: env.configDir, interactive: false }).read();
  return result.kind === "line" ? result.text : null;
}

function reportError(env: CliEnv, json: boolean, message: string, exitCode: number): number {
  if (json) new JsonEventWriter({ stdout: env.stdout, enabled: true }).emitError(message);
  else env.stderr.write(`error: ${message}\n`);
  return exitCode;
}
