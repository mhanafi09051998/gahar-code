import type { KeyInfo } from "../contracts/messages.js";
import { GaharError } from "../shared/errors.js";
import { clearGlobalApiKey, globalConfigPath, saveGlobalConfig } from "../config/index.js";
import { looksLikeApiKey, maskKey, resolveApiKey, type ApiKeySource, type ResolvedKey } from "./key.js";

export interface KeyValidator {
  validateKey(key?: string): Promise<KeyInfo>;
}

export interface AuthStatus {
  source: "env" | "config" | "none";
  maskedKey: string;
  configPath: string;
  info: KeyInfo | null;
  error?: string;
}

export interface LoginResult {
  key: string;
  maskedKey: string;
  configPath: string;
  info: KeyInfo;
}

/** Validates then persists the key into the global config (mode 0o600). */
export async function login(
  client: KeyValidator,
  key: string,
  configDir: string,
): Promise<LoginResult> {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw new GaharError("API key must not be empty", { code: "invalid_api_key", exitCode: 3 });
  }
  if (!looksLikeApiKey(trimmed)) {
    throw new GaharError(
      'That does not look like an OpenRouter key (expected a value starting with "sk-or-").',
      { code: "invalid_api_key", exitCode: 3 },
    );
  }
  await client.validateKey(trimmed);
  const configPath = await saveGlobalConfig(configDir, { apiKey: trimmed });
  return {
    key: trimmed,
    maskedKey: maskKey(trimmed),
    configPath,
    info: await client.validateKey(trimmed),
  };
}

/** Removes the apiKey from the global config. */
export async function logout(configDir: string): Promise<{ removed: boolean; configPath: string }> {
  const removed = await clearGlobalApiKey(configDir);
  return { removed, configPath: globalConfigPath(configDir) };
}

export function resolveKeyForStatus(loaded: ApiKeySource): ResolvedKey {
  return resolveApiKey(loaded);
}

/** Reports source, masked key and /key metadata without leaking the key. */
export async function status(
  client: KeyValidator | null,
  loaded: ApiKeySource,
  configDir: string,
): Promise<AuthStatus> {
  const resolved = resolveApiKey(loaded);
  const base: AuthStatus = {
    source: resolved.source,
    maskedKey: maskKey(resolved.key),
    configPath: globalConfigPath(configDir),
    info: null,
  };
  if (!resolved.key || !client) return base;
  try {
    base.info = await client.validateKey();
  } catch (error) {
    base.error = error instanceof Error ? error.message : String(error);
  }
  return base;
}

export function formatAuthStatus(result: AuthStatus): string {
  const lines = [
    `API key source: ${result.source}`,
    `API key: ${result.maskedKey}`,
    `Config file: ${result.configPath}`,
  ];
  if (result.info) {
    const info = result.info;
    if (typeof info.limit === "number") lines.push(`Limit: $${info.limit.toFixed(2)}`);
    if (typeof info.usage === "number") lines.push(`Usage: $${info.usage.toFixed(4)}`);
    if (typeof info.limit_remaining === "number") {
      lines.push(`Remaining: $${info.limit_remaining.toFixed(4)}`);
    }
    if (typeof info.is_free_tier === "boolean") {
      lines.push(`Free tier: ${info.is_free_tier ? "yes" : "no"}`);
    }
  }
  if (result.error) lines.push(`Note: ${result.error}`);
  return lines.join("\n");
}
