import { join } from "node:path";
import type { KeyInfo, ModelInfo } from "../contracts/messages.js";
import { atomicWriteFile, readTextFileIfExists } from "../shared/fsx.js";

export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface ModelCache {
  fetchedAt: number;
  models: ModelInfo[];
}

export function modelsCachePath(configDir: string): string {
  return join(configDir, "cache", "models.json");
}

export function filterModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter((model) => !model.id.includes(":batch"));
}

export function mapModelInfos(payload: unknown): ModelInfo[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const models: ModelInfo[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) continue;
    const model: ModelInfo = { id: record.id };
    if (typeof record.name === "string") model.name = record.name;
    if (typeof record.description === "string") model.description = record.description;
    if (typeof record.context_length === "number") model.context_length = record.context_length;
    if (record.pricing && typeof record.pricing === "object") {
      const pricing: Record<string, string> = {};
      for (const [key, value] of Object.entries(record.pricing as Record<string, unknown>)) {
        if (typeof value === "string") pricing[key] = value;
        else if (typeof value === "number") pricing[key] = String(value);
      }
      model.pricing = pricing;
    }
    if (Array.isArray(record.supported_parameters)) {
      model.supported_parameters = record.supported_parameters.filter(
        (item): item is string => typeof item === "string",
      );
    }
    if (record.architecture && typeof record.architecture === "object") {
      model.architecture = record.architecture as Record<string, unknown>;
    }
    if (record.top_provider && typeof record.top_provider === "object") {
      model.top_provider = record.top_provider as Record<string, unknown>;
    }
    models.push(model);
  }
  return models;
}

export async function readModelCache(
  configDir: string,
  ttlMs = MODEL_CACHE_TTL_MS,
): Promise<ModelInfo[] | null> {
  const raw = await readTextFileIfExists(modelsCachePath(configDir));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const cache = parsed as Partial<ModelCache>;
    if (typeof cache.fetchedAt !== "number" || !Array.isArray(cache.models)) return null;
    if (Date.now() - cache.fetchedAt > ttlMs) return null;
    return filterModels(cache.models);
  } catch {
    return null;
  }
}

/** Persists the model list; corrupt/unwritable caches never break a run. */
export async function writeModelCache(
  configDir: string,
  models: ModelInfo[],
  fetchedAt = Date.now(),
): Promise<void> {
  try {
    const payload: ModelCache = { fetchedAt, models };
    await atomicWriteFile(modelsCachePath(configDir), JSON.stringify(payload, null, 2));
  } catch {
    // cache is best effort
  }
}

/** Maps the /key response (with or without a data wrapper) to KeyInfo. */
export function mapKeyInfo(payload: unknown): KeyInfo {
  const data =
    payload && typeof payload === "object" && "data" in payload
      ? (payload as { data?: unknown }).data
      : payload;
  if (!data || typeof data !== "object") return {};
  const record = data as Record<string, unknown>;
  const info: KeyInfo = {};
  if (typeof record.label === "string") info.label = record.label;
  if (typeof record.limit === "number" || record.limit === null) {
    info.limit = record.limit as number | null;
  }
  if (typeof record.usage === "number") info.usage = record.usage;
  if (typeof record.limit_remaining === "number" || record.limit_remaining === null) {
    info.limit_remaining = record.limit_remaining as number | null;
  }
  if (typeof record.is_free_tier === "boolean") info.is_free_tier = record.is_free_tier;
  return info;
}
