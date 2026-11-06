import type { ChatResult, StreamHandlers, Usage } from "../contracts/messages.js";
import { GaharError, isAbortError } from "../shared/errors.js";
import { abortError } from "./errors.js";
import { NetworkError, networkError, streamPayloadError } from "./http.js";
import { applySsePayload, newAccumulator, readSseStream, type StreamAccumulator } from "./sse.js";

/** Default time a stream may go without any bytes (keep-alive comments count) before it is retried. */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

export interface Deadline {
  signal: AbortSignal;
  /** Restarts the idle timer; call it whenever bytes arrive. */
  touch: () => void;
  /** Why the deadline fired, or null while the request is still within its limits. */
  expired: () => string | null;
  done: () => void;
}

/** Links the caller signal with an optional total timeout and an optional idle timeout. */
export function createDeadline(
  signal: AbortSignal | undefined,
  limits: { totalMs?: number | undefined; idleMs?: number | undefined },
): Deadline {
  const controller = new AbortController();
  let reason: string | null = null;
  const expire = (why: string): void => {
    reason ??= why;
    controller.abort();
  };
  const { totalMs, idleMs } = limits;
  const total =
    totalMs !== undefined && totalMs > 0
      ? setTimeout(() => expire(`the request timed out after ${totalMs} ms`), totalMs)
      : undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const touch = (): void => {
    if (idleMs === undefined || idleMs <= 0) return;
    clearTimeout(idle);
    idle = setTimeout(() => expire(`no data for ${idleMs} ms; the connection stalled`), idleMs);
  };
  const onAbort = (): void => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  touch();
  return {
    signal: controller.signal,
    touch,
    expired: () => reason,
    done: () => {
      clearTimeout(total);
      clearTimeout(idle);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Turns an abort caused by the deadline (not the user) into a retryable network error. */
export function deadlineError(
  deadline: Deadline,
  userSignal: AbortSignal | undefined,
  error: unknown,
): unknown {
  const reason = deadline.expired();
  if (reason === null || userSignal?.aborted === true) return error;
  return new NetworkError(new Error(reason));
}

/**
 * Reads the SSE body into an accumulator, forwarding deltas. A body that ends
 * without [DONE] or a finish_reason was cut off and becomes a retryable error.
 */
export async function consumeChatStream(
  body: ReadableStream<Uint8Array>,
  deadline: Deadline,
  handlers: StreamHandlers,
): Promise<StreamAccumulator> {
  const acc = newAccumulator();
  let sentContent = 0;
  let sentReasoning = 0;
  let done = false;
  try {
    for await (const payload of readSseStream(body, deadline.signal, deadline.touch)) {
      if (!applySsePayload(acc, payload)) done = true;
      if (acc.error !== undefined) throw streamPayloadError(acc.error);
      if (acc.content.length > sentContent) {
        handlers.onText?.(acc.content.slice(sentContent));
        sentContent = acc.content.length;
      }
      if (acc.reasoning.length > sentReasoning) {
        handlers.onReasoning?.(acc.reasoning.slice(sentReasoning));
        sentReasoning = acc.reasoning.length;
      }
    }
  } catch (error) {
    if (isAbortError(error) || deadline.signal.aborted) throw abortError();
    if (error instanceof GaharError) throw error;
    throw networkError(error);
  }
  if (!done && acc.finishReason === null) {
    throw new NetworkError(new Error("the stream ended before the response was complete"));
  }
  return acc;
}

/** Builds the ChatResult; a completion with neither content nor tool calls is an error. */
export function finishResult(acc: StreamAccumulator, handlers: StreamHandlers): ChatResult {
  const toolCalls = acc.toolCalls.filter(Boolean);
  if (acc.content.length === 0 && toolCalls.length === 0) {
    throw new GaharError("OpenRouter returned an empty response", { code: "empty_response" });
  }
  const usage = acc.usage as Usage | undefined;
  if (usage) handlers.onUsage?.(usage);
  handlers.onFinish?.(acc.finishReason);
  return {
    message: {
      role: "assistant",
      content: acc.content.length > 0 ? acc.content : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(acc.reasoning.length > 0 ? { reasoning: acc.reasoning } : {}),
    },
    finishReason: acc.finishReason,
    ...(usage ? { usage } : {}),
    ...(acc.model ? { model: acc.model } : {}),
    ...(acc.generationId ? { generationId: acc.generationId } : {}),
  };
}
