import { GaharError, isAbortError, toErrorMessage } from "../shared/errors.js";
import {
  abortError,
  apiErrorFromBody,
  apiErrorFromPayload,
  extractMessage,
  isRetryableStatus,
  payloadStatus,
  retryAfterMs,
} from "./errors.js";

export class HttpStatusError extends GaharError {
  readonly status: number;
  readonly retryAfter: number | null;

  constructor(error: GaharError, status: number, retryAfter: number | null) {
    super(error.message, { code: error.code, exitCode: error.exitCode, cause: error.cause });
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export class NetworkError extends GaharError {
  constructor(error: unknown) {
    super(`Could not reach OpenRouter: ${toErrorMessage(error)}`, {
      code: "network_error",
      cause: error,
    });
  }
}

export function httpError(status: number, body: string, response: Response): GaharError {
  const base = apiErrorFromBody(status, body);
  const retryAfter = retryAfterMs({ get: (name) => response.headers.get(name) });
  return new HttpStatusError(base, status, retryAfter);
}

/** Error for a provider error object received inside the SSE stream. */
export function streamPayloadError(payload: unknown): GaharError {
  return new HttpStatusError(apiErrorFromPayload(payload), payloadStatus(payload), null);
}

export function networkError(error: unknown): GaharError {
  if (isAbortError(error)) return abortError();
  return new NetworkError(error);
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof HttpStatusError) return isRetryableStatus(error.status);
  if (error instanceof NetworkError) return true;
  if (error instanceof GaharError && error.code === "empty_response") return true;
  return false;
}

export function retryAfterOf(error: unknown): number | null {
  if (error instanceof HttpStatusError) return error.retryAfter;
  return null;
}

export function toError(error: unknown): GaharError {
  if (error instanceof GaharError) return error;
  return new GaharError(extractMessage(String(error)), { code: "api_error" });
}
