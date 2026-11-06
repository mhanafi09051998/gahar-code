import { GaharError, isAbortError, toErrorMessage } from "../shared/errors.js";

export const UPDATE_USER_AGENT = "gahar-code-cli";

/** An AbortSignal that fires after timeoutMs, with a fallback for runtimes without AbortSignal.timeout. */
export function timeoutSignal(timeoutMs: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return controller.signal;
}

/** Returns the injected fetch or the global one, failing clearly when neither exists. */
export function resolveFetch(fetchImpl: typeof fetch | undefined): typeof fetch {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new GaharError("No fetch implementation is available in this Node.js runtime.", {
      code: "update_failed",
    });
  }
  return doFetch;
}

/**
 * Unauthenticated GET. The repository is public and Gahar Code never stores or
 * transmits a GitHub token. Network failures become a GaharError with a reason.
 */
export async function httpGet(
  url: string,
  accept: string,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
): Promise<Response> {
  const doFetch = resolveFetch(fetchImpl);
  try {
    return await doFetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { Accept: accept, "User-Agent": UPDATE_USER_AGENT },
      signal: timeoutSignal(timeoutMs),
    });
  } catch (error) {
    const reason = isAbortError(error) ? `timed out after ${timeoutMs} ms` : toErrorMessage(error);
    throw new GaharError(`Request to ${url} failed: ${reason}`, {
      code: "update_failed",
      cause: error,
    });
  }
}

/** Accepts "1", "true", "yes", "on" (case-insensitive), matching config env parsing. */
export function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
