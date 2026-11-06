import { GaharError } from "../shared/errors.js";
import { apiErrorFromBody, extractMessage, isRetryableStatus, retryAfterMs } from "./errors.js";

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
    super(`Could not reach OpenRouter: ${describeNetwork(error)}`, {
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

export function networkError(error: unknown): GaharError {
  if (isAbort(error)) return abortError();
  return new NetworkError(error);
}

export function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) ||
    false
  );
}

export function abortError(): GaharError {
  const error = new GaharError("Request aborted", { code: "aborted" });
  error.name = "AbortError";
  return error;
}

function describeNetwork(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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
