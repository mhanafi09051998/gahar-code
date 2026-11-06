import type { LoadedConfig, ResolvedConfig } from "../contracts/config.js";
import { GaharError } from "../shared/errors.js";

export interface ApiKeySource {
  apiKey: string | null;
  apiKeySource: "env" | "config" | "none";
}

export interface ResolvedKey {
  key: string | null;
  source: "env" | "config" | "none";
}

/** Extracts apiKey/apiKeySource from either a LoadedConfig or a ResolvedConfig. */
export function apiKeySourceOf(loaded: LoadedConfig | ResolvedConfig | ApiKeySource): ApiKeySource {
  if ("config" in loaded) return loaded.config;
  return loaded;
}

/** Resolves the API key and its source from the already-resolved config (env wins there). */
export function resolveApiKey(loaded: LoadedConfig | ResolvedConfig | ApiKeySource): ResolvedKey {
  const { apiKey, apiKeySource } = apiKeySourceOf(loaded);
  const key = normalize(apiKey);
  if (!key || apiKeySource === "none") return { key: null, source: "none" };
  return { key, source: apiKeySource };
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
    throw new GaharError(
      "No OpenRouter API key configured. Set OPENROUTER_API_KEY or run: gahar auth login",
      { code: "missing_api_key", exitCode: 3 },
    );
  }
  return resolved.key;
}
