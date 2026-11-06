import type { LoadedConfig, ResolvedConfig } from "../contracts/config.js";

export interface ApiKeySource {
  apiKey: string | null;
  apiKeySource: "env" | "config" | "none";
}

export interface ResolvedKey {
  key: string | null;
  source: "env" | "config" | "none";
}

/** Resolves the API key and where it came from. */
/** Extracts apiKey/apiKeySource from either a LoadedConfig or a ResolvedConfig. */
export function apiKeySourceOf(loaded: LoadedConfig | ResolvedConfig | ApiKeySource): ApiKeySource {
  if ("config" in loaded) return loaded.config;
  return loaded;
}

export function resolveApiKey(loaded: LoadedConfig | ResolvedConfig | ApiKeySource): ResolvedKey {
  const source = apiKeySourceOf(loaded);
  const envKey = normalize(process.env.OPENROUTER_API_KEY);
  if (envKey) return { key: envKey, source: "env" };
  const configKey = normalize(source.apiKey);
  if (configKey) return { key: configKey, source: "config" };
  return { key: null, source: "none" };
}

function normalize(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Masks a key as first 8 + "..." + last 4. Never reveals the middle. */
export function maskKey(key: string | null | undefined): string {
  if (typeof key !== "string") return "(none)";
  const trimmed = key.trim();
  if (trimmed.length === 0) return "(none)";
  if (trimmed.length <= 12) return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

/** Returns true when the key looks like an OpenRouter key. */
export function looksLikeApiKey(key: string): boolean {
  const trimmed = key.trim();
  return trimmed.startsWith("sk-or-") && trimmed.length >= 20;
}

export function requireApiKey(resolved: ResolvedKey): string {
  if (!resolved.key) {
    const error = new Error(
      "No OpenRouter API key configured. Set OPENROUTER_API_KEY or run: gahar auth login",
    );
    error.name = "MissingApiKeyError";
    throw error;
  }
  return resolved.key;
}
