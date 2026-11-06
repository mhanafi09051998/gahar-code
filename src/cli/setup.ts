import { maskKey } from "../auth/key.js";
import type { GaharConfig } from "../contracts/config.js";
import type { ModelInfo } from "../contracts/messages.js";
import { DEFAULT_MODEL } from "../shared/defaults.js";
import { toErrorMessage } from "../shared/errors.js";
import { EXIT_AUTH_ERROR } from "./args.js";
import { type CommandIO, type KeyClient, promptAndSaveKey } from "./auth-cmd.js";
import { modelTable, topModels } from "./model-format.js";
import type { Questioner } from "./questioner.js";

export interface SetupDeps {
  env: NodeJS.ProcessEnv;
  questioner: Questioner;
  client: KeyClient & { listModels(): Promise<ModelInfo[]> };
  readGlobal: () => Promise<GaharConfig>;
  save: (patch: Partial<GaharConfig>) => Promise<string>;
}

const MAX_KEY_ATTEMPTS = 3;

/**
 * First-run wizard: make sure a valid key exists, pick a default model, save.
 * Non-interactive use: OPENROUTER_API_KEY and GAHAR_MODEL supply the answers.
 */
export async function runSetup(deps: SetupDeps, io: CommandIO): Promise<number> {
  const global = await deps.readGlobal();
  if (!(await ensureKey(deps, io, global))) return EXIT_AUTH_ERROR;
  const model = await chooseModel(deps, io, global.model);
  const path = await deps.save({ model });
  io.out(`default model: ${model}`);
  io.out(`saved ${path}`);
  io.out("Setup complete. Start with: gahar");
  return 0;
}

async function ensureKey(deps: SetupDeps, io: CommandIO, global: GaharConfig): Promise<boolean> {
  const envKey = deps.env.OPENROUTER_API_KEY?.trim();
  const existing = envKey || global.apiKey?.trim();
  if (existing) {
    try {
      await deps.client.validateKey(existing);
      io.out(`using API key ${maskKey(existing)} from ${envKey ? "OPENROUTER_API_KEY" : "config"}`);
      return true;
    } catch (error) {
      io.err(`the current API key was rejected: ${toErrorMessage(error)}`);
    }
  }
  if (!deps.questioner.interactive) {
    io.err("no valid API key. Set OPENROUTER_API_KEY or run 'gahar setup' in a terminal.");
    return false;
  }
  io.out("Get a key at https://openrouter.ai/settings/keys");
  const authDeps = {
    client: deps.client,
    questioner: deps.questioner,
    saveKey: async (key: string) => {
      await deps.save({ apiKey: key });
    },
  };
  for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt += 1) {
    if ((await promptAndSaveKey(authDeps, io)) !== null) return true;
  }
  return false;
}

async function chooseModel(deps: SetupDeps, io: CommandIO, current?: string): Promise<string> {
  const fallback = deps.env.GAHAR_MODEL?.trim() || current || DEFAULT_MODEL;
  let catalog: ModelInfo[] = [];
  try {
    catalog = await deps.client.listModels();
  } catch (error) {
    io.err(`could not load the live model catalog: ${toErrorMessage(error)}`);
  }
  const choices = topModels(catalog, 10);
  io.out("");
  for (const line of modelTable(choices, fallback)) io.out(line);
  const known = new Set(catalog.map((model) => model.id));
  for (;;) {
    const answer = (
      await deps.questioner.ask(
        `Choose a model [1-${choices.length}] or id (Enter for ${fallback}): `,
      )
    ).trim();
    const picked = resolveChoice(answer, choices, fallback);
    if (picked !== null && (catalog.length === 0 || known.has(picked) || picked === fallback)) {
      return picked;
    }
    io.err(`unknown model: ${answer}`);
    if (!deps.questioner.interactive) return fallback;
  }
}

/** Maps "", a list number or a model id to a model id; null when the number is out of range. */
export function resolveChoice(
  answer: string,
  choices: readonly ModelInfo[],
  fallback: string,
): string | null {
  if (answer === "") return fallback;
  if (/^\d+$/.test(answer)) return choices[Number(answer) - 1]?.id ?? null;
  return answer;
}
