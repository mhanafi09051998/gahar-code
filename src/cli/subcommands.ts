import { OpenRouterClient } from "../api/openrouter.js";
import {
  clearGlobalApiKey,
  loadConfig,
  readGlobalConfig,
  saveGlobalConfig,
} from "../config/store.js";
import type { ConfigOverrides, LoadedConfig } from "../contracts/config.js";
import { checkForUpdateOrThrow } from "../update/check.js";
import { performUpdate } from "../update/install.js";
import type { CliOptions } from "./args.js";
import { type CommandIO, runAuth } from "./auth-cmd.js";
import { runDoctor } from "./doctor.js";
import { createDoctorProbes } from "./doctor-probes.js";
import type { CliEnv } from "./env.js";
import { runModel } from "./model-cmd.js";
import { createQuestioner } from "./questioner.js";
import { runSessions } from "./sessions-cmd.js";
import { runSetup } from "./setup.js";
import { runUpdate } from "./update-cmd.js";

export function configOverrides(options: CliOptions, env: CliEnv): ConfigOverrides {
  const overrides: ConfigOverrides = { configDir: env.configDir, debug: options.debug };
  if (options.model !== undefined) overrides.model = options.model;
  if (options.permissionMode !== undefined) overrides.permissionMode = options.permissionMode;
  if (options.maxTokens !== undefined) overrides.maxTokens = options.maxTokens;
  if (options.noColor) overrides.noColor = true;
  return overrides;
}

export async function loadCliConfig(options: CliOptions, env: CliEnv): Promise<LoadedConfig> {
  const loaded = await loadConfig({
    cwd: env.cwd,
    env: env.env,
    overrides: configOverrides(options, env),
  });
  for (const warning of loaded.config.warnings) env.stderr.write(`warning: ${warning}\n`);
  return loaded;
}

export function commandIO(env: CliEnv): CommandIO {
  return {
    out: (line) => env.stdout.write(`${line}\n`),
    err: (line) => env.stderr.write(`${line}\n`),
  };
}

export function createClient(loaded: LoadedConfig): OpenRouterClient {
  const { config } = loaded;
  return new OpenRouterClient({
    apiKey: config.apiKey ?? "",
    baseUrl: config.baseUrl,
    configDir: config.configDir,
  });
}

/** Runs `gahar <name> ...args` and returns the exit code. */
export async function runSubcommand(
  name: string,
  args: string[],
  options: CliOptions,
  env: CliEnv,
): Promise<number> {
  const io = commandIO(env);
  if (name === "update") {
    return runUpdate(
      args,
      {
        check: () => checkForUpdateOrThrow({ configDir: env.configDir, allowCache: false }),
        perform: (updateOptions) => performUpdate(updateOptions, { configDir: env.configDir }),
      },
      io,
    );
  }
  const loaded = await loadCliConfig(options, env);
  const { configDir, cwd } = loaded.config;
  const client = createClient(loaded);
  const questioner = createQuestioner({ stderr: env.stderr, interactive: env.stdinIsTTY });
  const save = (patch: Parameters<typeof saveGlobalConfig>[1]) =>
    saveGlobalConfig(configDir, patch, env.env);
  try {
    switch (name) {
      case "setup":
        return await runSetup(
          {
            env: env.env,
            questioner,
            client,
            readGlobal: () => readGlobalConfig(configDir, env.env),
            save,
          },
          io,
        );
      case "auth":
        return await runAuth(
          args[0],
          {
            loaded,
            client,
            questioner,
            saveKey: async (key) => {
              await save({ apiKey: key });
            },
            clearKey: () => clearGlobalApiKey(configDir, env.env),
            envKeySet: Boolean(env.env.OPENROUTER_API_KEY?.trim()),
          },
          io,
        );
      case "model":
        return await runModel(
          args,
          { loaded, listModels: () => client.listModels(), saveModel: (model) => save({ model }) },
          io,
        );
      case "sessions":
        return await runSessions(args, { configDir, cwd }, io);
      case "doctor":
        return await runDoctor(createDoctorProbes(loaded.config, client), io);
      default:
        io.err(`unknown command: ${name}`);
        return 2;
    }
  } finally {
    questioner.close();
  }
}
