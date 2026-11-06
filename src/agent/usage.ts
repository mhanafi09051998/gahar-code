import type { ModelInfo, Usage } from "../contracts/messages.js";

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  costUsd: number;
  requests: number;
  estimated: boolean;
}

export function emptyTotals(): UsageTotals {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    requests: 0,
    estimated: false,
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Price per token from an OpenRouter pricing string (USD per token). */
export function pricePerToken(value: string | undefined): number {
  if (typeof value !== "string") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Estimates cost from model pricing when the provider omits usage.cost. */
export function estimateCost(usage: Usage, model?: ModelInfo | null): number {
  if (!model?.pricing) return 0;
  const prompt = num(usage.prompt_tokens);
  const completion = num(usage.completion_tokens);
  const request = pricePerToken(model.pricing.request);
  return (
    prompt * pricePerToken(model.pricing.prompt) +
    completion * pricePerToken(model.pricing.completion) +
    request
  );
}

export interface AccumulateOptions {
  model?: ModelInfo | null;
}

/** Adds one API response's usage into the running totals. */
export function accumulate(
  totals: UsageTotals,
  usage: Usage | undefined,
  options: AccumulateOptions = {},
): UsageTotals {
  if (!usage) return totals;
  const prompt = num(usage.prompt_tokens);
  const completion = num(usage.completion_tokens);
  const total = num(usage.total_tokens) || prompt + completion;
  totals.promptTokens += prompt;
  totals.completionTokens += completion;
  totals.totalTokens += total;
  totals.cachedTokens += num(usage.prompt_tokens_details?.cached_tokens);
  totals.requests += 1;
  if (typeof usage.cost === "number" && Number.isFinite(usage.cost)) {
    totals.costUsd += usage.cost;
  } else {
    const estimated = estimateCost(usage, options.model);
    if (estimated > 0) {
      totals.costUsd += estimated;
      totals.estimated = true;
    }
  }
  return totals;
}

/** Converts totals back into a Usage object for events/results. */
export function toUsage(totals: UsageTotals): Usage {
  return {
    prompt_tokens: totals.promptTokens,
    completion_tokens: totals.completionTokens,
    total_tokens: totals.totalTokens,
    cost: totals.costUsd,
    prompt_tokens_details: { cached_tokens: totals.cachedTokens },
  };
}

/** Formats a USD amount, e.g. "$0.0123" (or "<$0.0001" for tiny amounts). */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.0000";
  if (usd < 0.0001) return "<$0.0001";
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

export function formatUsageSummary(totals: UsageTotals): string {
  const parts = [
    `${formatTokens(totals.promptTokens)} in`,
    `${formatTokens(totals.completionTokens)} out`,
    formatCost(totals.costUsd),
  ];
  if (totals.estimated) parts.push("(estimated)");
  return parts.join(" · ");
}
