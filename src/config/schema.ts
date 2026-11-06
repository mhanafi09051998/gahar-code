import type { GaharConfig, PermissionMode, ProjectConfig } from "../contracts/config.js";
import { DEFAULT_BASE_URL, DEFAULT_MAX_TOKENS, DEFAULT_MODEL } from "../shared/defaults.js";

const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "auto-edit", "full-auto"];
const SECRET_FIELD = /^(api[-_]?key|.*(?:key|token|secret))$/i;

/**
 * Validated config fields; updateCheck and baseUrl are honored only in the
 * global file, and a project file may set permissionMode only to "ask".
 */
export interface ConfigValues extends ProjectConfig {
  updateCheck?: boolean;
  baseUrl?: string;
}

export type ConfigScope = "global" | "project";

const GLOBAL_ONLY_FIELDS = new Set(["updateCheck", "baseUrl"]);

export interface NormalizeResult {
  values: ConfigValues;
  secretsIgnored: string[];
  unknownFields: string[];
  /** A project file may only tighten to "ask"; a looser mode lands here instead. */
  permissionModeIgnored: PermissionMode | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates one raw config object; unknown/invalid fields become warnings. */
export function normalizeConfig(raw: unknown, scope: ConfigScope = "global"): NormalizeResult {
  const result: NormalizeResult = {
    values: {},
    secretsIgnored: [],
    unknownFields: [],
    permissionModeIgnored: null,
  };
  if (!isRecord(raw)) {
    if (raw !== undefined && raw !== null) result.unknownFields.push("<root>");
    return result;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (scope === "project" && GLOBAL_ONLY_FIELDS.has(key)) {
      result.unknownFields.push(key);
      continue;
    }
    switch (key) {
      case "version":
      case "$schema":
      case "apiKey":
        if (key === "apiKey") result.secretsIgnored.push(key);
        break;
      case "model":
        if (typeof value === "string" && value.trim().length > 0)
          result.values.model = value.trim();
        else result.unknownFields.push(key);
        break;
      case "maxTokens":
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          result.values.maxTokens = Math.floor(value);
        } else result.unknownFields.push(key);
        break;
      case "permissionMode":
        if (typeof value !== "string" || !isPermissionMode(value)) result.unknownFields.push(key);
        else if (scope === "project" && value !== "ask") result.permissionModeIgnored = value;
        else result.values.permissionMode = value;
        break;
      case "baseUrl":
        if (typeof value === "string" && value.trim().length > 0)
          result.values.baseUrl = value.trim();
        else result.unknownFields.push(key);
        break;
      case "updateCheck":
      case "contextCompaction":
      case "showReasoning":
        if (typeof value === "boolean") result.values[key] = value;
        else result.unknownFields.push(key);
        break;
      default:
        if (SECRET_FIELD.test(key)) result.secretsIgnored.push(key);
        else result.unknownFields.push(key);
    }
  }
  return result;
}

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

/** Parses a JSON config file; never throws. */
export function parseConfigText(text: string): { value: unknown; error: string | null } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { value: {}, error: null };
  try {
    return { value: JSON.parse(trimmed) as unknown, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { value: null, error: message };
  }
}

export interface DefaultsInput {
  cwd: string;
  configDir: string;
  env?: NodeJS.ProcessEnv;
}

export interface EnvOverrides {
  apiKey?: string;
  model?: string;
  permissionMode?: PermissionMode;
  baseUrl?: string;
  noUpdateCheck?: boolean;
  debug?: boolean;
  noColor?: boolean;
  invalidPermissionMode?: string;
}

/** Reads env overrides, ignoring blank values. */
export function readEnvOverrides(env: NodeJS.ProcessEnv = process.env): EnvOverrides {
  const overrides: EnvOverrides = {};
  const apiKey = env.OPENROUTER_API_KEY;
  if (apiKey && apiKey.trim().length > 0) overrides.apiKey = apiKey.trim();
  const model = env.GAHAR_MODEL;
  if (model && model.trim().length > 0) overrides.model = model.trim();
  const baseUrl = env.GAHAR_BASE_URL;
  if (baseUrl && baseUrl.trim().length > 0) overrides.baseUrl = baseUrl.trim();
  const mode = env.GAHAR_PERMISSION_MODE;
  if (mode && mode.trim().length > 0) {
    if (isPermissionMode(mode.trim())) overrides.permissionMode = mode.trim() as PermissionMode;
    else overrides.invalidPermissionMode = mode.trim();
  }
  if (isTruthy(env.GAHAR_NO_UPDATE_CHECK)) overrides.noUpdateCheck = true;
  if (isTruthy(env.GAHAR_DEBUG)) overrides.debug = true;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") overrides.noColor = true;
  return overrides;
}

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export const CONFIG_DEFAULTS = {
  model: DEFAULT_MODEL,
  maxTokens: DEFAULT_MAX_TOKENS,
  baseUrl: DEFAULT_BASE_URL,
} as const;

export type { GaharConfig };
