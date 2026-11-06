import type { ModelInfo } from "../contracts/messages.js";
import { RECOMMENDED_MODELS } from "../shared/defaults.js";

const RECOMMENDED: readonly string[] = RECOMMENDED_MODELS;

/** OpenRouter prices are USD per token as strings; shows USD per million tokens. */
export function perMillion(price: string | undefined): string {
  const value = Number(price);
  if (price === undefined || price === "" || !Number.isFinite(value)) return "?";
  if (value === 0) return "free";
  return `$${(value * 1_000_000).toFixed(2)}`;
}

export function formatContext(tokens: number | undefined): string {
  if (tokens === undefined || tokens <= 0) return "?";
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.round(tokens / 1000)}k`;
}

export function isToolCapable(model: ModelInfo): boolean {
  return model.supported_parameters?.includes("tools") ?? true;
}

export function isRecommended(id: string): boolean {
  return RECOMMENDED.includes(id);
}

/**
 * Recommended models first (in their curated order, using live catalog data
 * when available), then the remaining tool-capable models up to `limit`.
 */
export function topModels(catalog: readonly ModelInfo[], limit = 10): ModelInfo[] {
  const byId = new Map(catalog.map((model) => [model.id, model]));
  const picked: ModelInfo[] = RECOMMENDED.map((id) => byId.get(id) ?? { id }).filter(
    (model) => catalog.length === 0 || byId.has(model.id),
  );
  for (const model of catalog) {
    if (picked.length >= limit) break;
    if (!isRecommended(model.id) && isToolCapable(model)) picked.push(model);
  }
  return picked.slice(0, Math.max(limit, 0));
}

/** Markdown-ish table: id, context, input/output price per 1M tokens, marker. */
export function modelTable(models: readonly ModelInfo[], current?: string): string[] {
  const width = Math.max(8, ...models.map((model) => model.id.length));
  const header = `   ${"model".padEnd(width)}  context  in/1M     out/1M`;
  const rows = models.map((model, index) => {
    const marker = model.id === current ? "*" : isRecommended(model.id) ? "+" : " ";
    return [
      `${marker}${String(index + 1).padStart(2)} ${model.id.padEnd(width)}`,
      formatContext(model.context_length).padStart(7),
      perMillion(model.pricing?.prompt).padEnd(9),
      perMillion(model.pricing?.completion),
    ].join("  ");
  });
  return [header, ...rows, "", "* current   + recommended"];
}
