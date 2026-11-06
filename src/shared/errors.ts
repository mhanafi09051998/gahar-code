export interface GaharErrorOptions {
  code?: string;
  exitCode?: number;
  cause?: unknown;
  details?: unknown;
}

export class GaharError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(message: string, options: GaharErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "GaharError";
    this.code = options.code ?? "gahar_error";
    this.exitCode = options.exitCode ?? 1;
    this.details = options.details;
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) ||
    false
  );
}

export function describeApiError(status: number, message: string): GaharError {
  if (status === 401) {
    return new GaharError("OpenRouter rejected the API key (401). Run: gahar auth login", {
      code: "unauthorized",
      exitCode: 3,
    });
  }
  if (status === 402) {
    return new GaharError(
      "OpenRouter reports insufficient credits (402). Add credits at https://openrouter.ai/settings/credits",
      { code: "insufficient_credits" },
    );
  }
  if (status === 403) {
    return new GaharError(`OpenRouter refused the request (403): ${message}`, { code: "forbidden" });
  }
  if (status === 404) {
    return new GaharError(
      `Model or endpoint not found (404): ${message}. Try: gahar model list`,
      { code: "not_found" },
    );
  }
  if (status === 429) {
    return new GaharError(
      "OpenRouter rate limit reached (429). Wait a moment or choose another model.",
      { code: "rate_limited" },
    );
  }
  if (status >= 500) {
    return new GaharError(`OpenRouter/provider error (${status}): ${message}`, {
      code: "provider_error",
    });
  }
  return new GaharError(`OpenRouter error (${status}): ${message}`, { code: "api_error" });
}
