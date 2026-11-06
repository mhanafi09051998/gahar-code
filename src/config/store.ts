import type {
  ConfigOverrides,
  GaharConfig,
  LoadedConfig,
  ProjectConfig,
  ResolvedConfig,
} from "../contracts/config.js";
import {
  atomicWriteFile,
  chmodBestEffort,
  ensureDir,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  readTextFileIfExists,
} from "../shared/fsx.js";
import {
  defaultConfigDir,
  globalConfigBackupPath,
  globalConfigPath,
  projectConfigPath,
  realCwd,
} from "./paths.js";
import {
  CONFIG_DEFAULTS,
  type ConfigValues,
  type EnvOverrides,
  normalizeConfig,
  parseConfigText,
  readEnvOverrides,
} from "./schema.js";

export interface LoadOptions {
  cwd: string;
  overrides?: ConfigOverrides;
  env?: NodeJS.ProcessEnv;
  /** Test seam: skips realpath so paths stay comparable. */
  resolveReal?: (input: string) => Promise<string>;
}

const CONFIG_MODE = PRIVATE_FILE_MODE;

/** Reads one config file; a corrupt global file is backed up to backupPath. */
async function readConfigFile(
  filePath: string,
  backupPath: string | null,
  warnings: string[],
): Promise<Record<string, unknown> | null> {
  const text = await readTextFileIfExists(filePath);
  if (text === null) return null;
  const parsed = parseConfigText(text);
  if (parsed.error !== null) {
    if (backupPath !== null) {
      try {
        await atomicWriteFile(backupPath, text, { mode: CONFIG_MODE });
        warnings.push(
          `Global config was corrupt (${parsed.error}); backed up to ${backupPath} and defaults were used.`,
        );
      } catch {
        warnings.push(`Global config was corrupt (${parsed.error}) and could not be backed up.`);
      }
    } else {
      warnings.push(`Project config ${filePath} is corrupt (${parsed.error}); it was ignored.`);
    }
    return null;
  }
  if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    warnings.push(`Config file ${filePath} does not contain a JSON object; it was ignored.`);
    return null;
  }
  return parsed.value as Record<string, unknown>;
}

/** Loads config with precedence CLI > env > project > global > defaults. */
export async function loadConfig(options: LoadOptions): Promise<LoadedConfig> {
  const env = options.env ?? process.env;
  const warnings: string[] = [];
  const cli = options.overrides ?? {};
  const envOverrides: EnvOverrides = readEnvOverrides(env);
  const configDir = cli.configDir ?? defaultConfigDir(env);
  const resolveReal = options.resolveReal ?? realCwd;
  const cwd = await resolveReal(options.cwd);
  const globalPath = globalConfigPath(configDir);
  const projectPath = projectConfigPath(cwd);

  const globalRaw = await readConfigFile(globalPath, globalConfigBackupPath(configDir), warnings);
  const projectRaw = await readConfigFile(projectPath, null, warnings);
  const global = normalizeConfig(globalRaw, "global");
  const project = normalizeConfig(projectRaw, "project");
  reportWarnings("global", global, warnings);
  reportWarnings("project", project, warnings);
  if (envOverrides.invalidPermissionMode) {
    warnings.push(
      `GAHAR_PERMISSION_MODE=${envOverrides.invalidPermissionMode} is not a valid mode; it was ignored.`,
    );
  }

  const globalConfig = toGaharConfig(global.values, globalRaw);
  const projectConfig: ProjectConfig | null = projectRaw ? { ...project.values } : null;
  const apiKey = envOverrides.apiKey ?? globalConfig.apiKey ?? null;
  const apiKeySource: ResolvedConfig["apiKeySource"] = envOverrides.apiKey
    ? "env"
    : globalConfig.apiKey
      ? "config"
      : "none";

  const config: ResolvedConfig = {
    cwd,
    configDir,
    apiKey,
    apiKeySource,
    model:
      pick(cli.model, envOverrides.model, projectConfig?.model, globalConfig.model) ??
      CONFIG_DEFAULTS.model,
    maxTokens:
      pickNumber(cli.maxTokens, projectConfig?.maxTokens, globalConfig.maxTokens) ??
      CONFIG_DEFAULTS.maxTokens,
    permissionMode:
      cli.permissionMode ??
      envOverrides.permissionMode ??
      projectConfig?.permissionMode ??
      globalConfig.permissionMode ??
      "ask",
    updateCheck:
      pickBoolean(
        envOverrides.noUpdateCheck === true ? false : undefined,
        globalConfig.updateCheck,
      ) ?? true,
    contextCompaction:
      pickBoolean(projectConfig?.contextCompaction, globalConfig.contextCompaction) ?? true,
    showReasoning: pickBoolean(projectConfig?.showReasoning, globalConfig.showReasoning) ?? false,
    baseUrl:
      pick(cli.baseUrl, envOverrides.baseUrl, global.values.baseUrl) ?? CONFIG_DEFAULTS.baseUrl,
    debug: cli.debug ?? envOverrides.debug ?? false,
    noColor: cli.noColor ?? envOverrides.noColor ?? false,
    warnings,
  };

  return {
    config,
    globalPath,
    projectPath: projectRaw ? projectPath : null,
    globalConfig,
    projectConfig,
  };
}

function reportWarnings(
  scope: string,
  result: ReturnType<typeof normalizeConfig>,
  warnings: string[],
): void {
  for (const field of result.secretsIgnored) {
    if (scope === "project") {
      warnings.push(
        `Ignored "${field}" in the project config: secrets may only come from the environment or the global config file.`,
      );
    } else {
      warnings.push(`Ignored unexpected secret field "${field}" in the global config.`);
    }
  }
  if (result.permissionModeIgnored !== null) {
    warnings.push(
      `Ignored permissionMode "${result.permissionModeIgnored}" in the project config: a repository may only set "ask". Use --permission-mode, GAHAR_PERMISSION_MODE or the global config for looser modes.`,
    );
  }
  for (const field of result.unknownFields) {
    if (field === "<root>") continue;
    warnings.push(`Ignored unknown or invalid config field "${field}" in the ${scope} config.`);
  }
}

function toGaharConfig(values: ConfigValues, raw: Record<string, unknown> | null): GaharConfig {
  const config: GaharConfig = { version: 1 };
  if (raw && typeof raw.apiKey === "string" && raw.apiKey.trim().length > 0) {
    config.apiKey = raw.apiKey.trim();
  }
  if (values.model !== undefined) config.model = values.model;
  if (values.maxTokens !== undefined) config.maxTokens = values.maxTokens;
  if (values.permissionMode !== undefined) config.permissionMode = values.permissionMode;
  if (values.contextCompaction !== undefined) config.contextCompaction = values.contextCompaction;
  if (values.showReasoning !== undefined) config.showReasoning = values.showReasoning;
  if (values.updateCheck !== undefined) config.updateCheck = values.updateCheck;
  return config;
}

function pick(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function pickNumber(...values: (number | undefined)[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function pickBoolean(...values: (boolean | undefined)[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

/** Merges a patch into the global config file, preserving unknown-free shape. */
export async function saveGlobalConfig(
  configDir: string,
  patch: Partial<GaharConfig>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const dir = configDir || defaultConfigDir(env);
  const filePath = globalConfigPath(dir);
  const existing = await readTextFileIfExists(filePath);
  let current: Record<string, unknown> = {};
  if (existing !== null) {
    const parsed = parseConfigText(existing);
    if (parsed.error === null && parsed.value && typeof parsed.value === "object") {
      current = parsed.value as Record<string, unknown>;
    }
  }
  const merged: Record<string, unknown> = { ...current, ...patch, version: 1 };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key];
  }
  await ensureDir(dir, PRIVATE_DIR_MODE);
  await atomicWriteFile(filePath, `${JSON.stringify(merged, null, 2)}\n`, { mode: CONFIG_MODE });
  await chmodBestEffort(filePath, CONFIG_MODE);
  return filePath;
}

/** Removes the apiKey from the global config file. Returns true when removed. */
export async function clearGlobalApiKey(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const dir = configDir || defaultConfigDir(env);
  const filePath = globalConfigPath(dir);
  const existing = await readTextFileIfExists(filePath);
  if (existing === null) return false;
  const parsed = parseConfigText(existing);
  if (parsed.error !== null || !parsed.value || typeof parsed.value !== "object") return false;
  const current = parsed.value as Record<string, unknown>;
  if (!("apiKey" in current)) return false;
  delete current.apiKey;
  await atomicWriteFile(filePath, `${JSON.stringify(current, null, 2)}\n`, { mode: CONFIG_MODE });
  await chmodBestEffort(filePath, CONFIG_MODE);
  return true;
}

/** Reads the raw global config object without resolving precedence. */
export async function readGlobalConfig(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GaharConfig> {
  const filePath = globalConfigPath(configDir || defaultConfigDir(env));
  const text = await readTextFileIfExists(filePath);
  if (text === null) return { version: 1 };
  const parsed = parseConfigText(text);
  if (parsed.error !== null || !parsed.value || typeof parsed.value !== "object") {
    return { version: 1 };
  }
  return toGaharConfig(
    normalizeConfig(parsed.value).values,
    parsed.value as Record<string, unknown>,
  );
}
