import type { LoadedConfig } from "../contracts/config.js";
import type { ModelInfo } from "../contracts/messages.js";
import { toErrorMessage } from "../shared/errors.js";
import { EXIT_ARG_ERROR } from "./args.js";
import type { CommandIO } from "./auth-cmd.js";
import { isToolCapable, modelTable, topModels } from "./model-format.js";

export interface ModelDeps {
  loaded: LoadedConfig;
  listModels: () => Promise<ModelInfo[]>;
  saveModel: (model: string) => Promise<string>;
}

export async function runModel(
  args: readonly string[],
  deps: ModelDeps,
  io: CommandIO,
): Promise<number> {
  const [action = "show", id] = args;
  if (action === "show") return modelShow(deps, io);
  if (action === "list") return modelList(deps, io, args.includes("--all"));
  if (action === "set") return modelSet(id, deps, io);
  io.err(`unknown model action: ${action} (expected list, set <id> or show)`);
  return EXIT_ARG_ERROR;
}

function modelShow(deps: ModelDeps, io: CommandIO): number {
  const { loaded } = deps;
  io.out(`model: ${loaded.config.model}`);
  const fromProject = loaded.projectConfig?.model !== undefined && loaded.projectPath !== null;
  io.out(`config: ${fromProject ? loaded.projectPath : loaded.globalPath}`);
  return 0;
}

async function modelList(deps: ModelDeps, io: CommandIO, all: boolean): Promise<number> {
  let catalog: ModelInfo[];
  try {
    catalog = await deps.listModels();
  } catch (error) {
    io.err(`could not load the model catalog: ${toErrorMessage(error)}`);
    return 1;
  }
  const models = all ? catalog.filter(isToolCapable) : topModels(catalog, 15);
  for (const line of modelTable(models, deps.loaded.config.model)) io.out(line);
  if (!all) io.out("Run 'gahar model list --all' for every tool-capable model.");
  return 0;
}

async function modelSet(id: string | undefined, deps: ModelDeps, io: CommandIO): Promise<number> {
  if (id === undefined || id.trim() === "") {
    io.err("usage: gahar model set <id>");
    return EXIT_ARG_ERROR;
  }
  let catalog: ModelInfo[];
  try {
    catalog = await deps.listModels();
  } catch (error) {
    io.err(`could not verify the model id: ${toErrorMessage(error)}`);
    return 1;
  }
  const match = catalog.find((model) => model.id === id);
  if (match === undefined) {
    io.err(`unknown model: ${id}. Run: gahar model list`);
    return EXIT_ARG_ERROR;
  }
  if (!isToolCapable(match)) io.err(`warning: ${id} does not advertise tool calling support`);
  const path = await deps.saveModel(id);
  io.out(`default model set to ${id} (${path})`);
  return 0;
}
