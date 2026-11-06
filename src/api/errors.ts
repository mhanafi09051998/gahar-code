import { GaharError } from "../shared/errors.js";

export interface HeaderReader {
  get(name: string): string | null;
}

export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
export const MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 4000;

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

export function retryAfterMs(headers?: HeaderReader | null): number | null {
  if (!headers) return null;
  const raw = headers.get("retry-after") ?? headers.get("Retry-After");
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

/** Exponential backoff with full jitter, bounded by MAX_BACKOFF_MS. */
export function computeBackoffMs(attempt: number, retryAfter?: number | null): number {
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter, 60000);
  }
  const base = Math.min(MAX_BACKOFF_MS, 250 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base / 2 + Math.random() * (base / 2));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortError(): GaharError {
  const error = new GaharError("Request aborted", { code: "aborted" });
  error.name = "AbortError";
  return error;
}

/** Build a GaharError from a provider error body (JSON or plain text). */
export function apiErrorFromBody(status: number, body: string): GaharError {
  return statusError(status, extractMessage(body));
}

/** Build a GaharError when the provider reported an error object mid-stream. */
export function apiErrorFromPayload(payload: unknown, status = 0): GaharError {
  const message = payloadMessage(payload) ?? "provider reported an error";
  return statusError(status, message);
}

function payloadMessage(payload: unknown): string | null {
  if (typeof payload === "string") return payload.length > 0 ? payload : null;
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.length > 0) return record.message;
  if (typeof record.error === "string" && record.error.length > 0) return record.error;
  if (record.error && typeof record.error === "object") {
    const nested = (record.error as Record<string, unknown>).message;
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  return null;
}

function statusError(status: number, message: string): GaharError {
  if (status === 401) {
    return new GaharError(`OpenRouter rejected the API key (401): ${message}`, {
      code: "unauthorized",
      exitCode: 3,
    });
  }
  if (status === 402) {
    return new GaharError(`OpenRouter reports insufficient credits (402): ${message}`, {
      code: "insufficient_credits",
    });
  }
  if (status === 403) {
    return new GaharError(`OpenRouter refused the request (403): ${message}`, {
      code: "forbidden",
    });
  }
  if (status === 404) {
    return new GaharError(`Model or endpoint not found (404): ${message}`, {
      code: "not_found",
    });
  }
  if (status === 429) {
    return new GaharError(`OpenRouter rate limit reached (429): ${message}`, {
      code: "rate_limited",
    });
  }
  if (status >= 500) {
    return new GaharError(`OpenRouter/provider error (${status}): ${message}`, {
      code: "provider_error",
    });
  }
  return new GaharError(`OpenRouter error (${status}): ${message}`, { code: "api_error" });
}

/** Extract a human readable message from a provider body (JSON or plain text). */
export function extractMessage(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return "no response body";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const message = payloadMessage(parsed);
    if (message) return message;
  } catch {
    // not JSON, fall through to the raw text
  }
  return trimmed.slice(0, 400);
}
