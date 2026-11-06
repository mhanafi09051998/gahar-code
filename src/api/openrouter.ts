import type {
  ChatClient,
  ChatRequest,
  ChatResult,
  KeyInfo,
  ModelInfo,
  Usage,
} from "../contracts/messages.js";
import { DEFAULT_BASE_URL, HTTP_REFERER, X_TITLE } from "../shared/defaults.js";
import { GaharError } from "../shared/errors.js";
import {
  MAX_ATTEMPTS,
  apiErrorFromPayload,
  computeBackoffMs,
  extractMessage,
  isRetryableStatus,
  sleep,
} from "./errors.js";
import {
  HttpStatusError,
  NetworkError,
  abortError,
  httpError,
  isAbort,
  isRetryable,
  networkError,
  retryAfterOf,
  toError,
} from "./http.js";
import { filterModels, mapKeyInfo, mapModelInfos, readModelCache, writeModelCache } from "./models.js";
import { applySsePayload, readSseStream, type StreamAccumulator } from "./sse.js";

export interface OpenRouterClientOptions {
  apiKey: string;
  baseUrl?: string;
  configDir?: string;
  fetchImpl?: typeof fetch;
  reasoning?: { effort?: string; max_tokens?: number; exclude?: boolean };
  maxRetries?: number;
  retryDelayMs?: number;
  cacheTtlMs?: number;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  timeoutMs?: number;
}

const KEY_CACHE_TTL_MS = 5 * 60 * 1000;

export class OpenRouterClient implements ChatClient {
  private readonly baseUrl: string;
  private readonly configDir: string | undefined;
  private readonly doFetch: typeof fetch;
  private readonly apiKey: string;
  private readonly reasoning: OpenRouterClientOptions["reasoning"];
  private readonly maxRetries: number;
  private readonly retryDelayMs: number | undefined;
  private readonly cacheTtlMs: number | undefined;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly timeoutMs: number | undefined;
  private modelsMemo: ModelInfo[] | null = null;
  private keyMemo: { at: number; info: KeyInfo } | null = null;

  constructor(options: OpenRouterClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.configDir = options.configDir;
    this.doFetch = options.fetchImpl ?? fetch;
    this.reasoning = options.reasoning;
    this.maxRetries = options.maxRetries ?? MAX_ATTEMPTS;
    this.retryDelayMs = options.retryDelayMs;
    this.cacheTtlMs = options.cacheTtlMs;
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.timeoutMs = options.timeoutMs;
  }

  private headers(key?: string): Record<string, string> {
    return {
      Authorization: `Bearer ${key ?? this.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": HTTP_REFERER,
      "X-Title": X_TITLE,
    };
  }

  private timeoutSignal(signal?: AbortSignal): { signal?: AbortSignal; done: () => void } {
    if (this.timeoutMs === undefined || this.timeoutMs <= 0) return { signal, done: () => {} };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const combined = signal ? controller.signal : controller.signal;
    return {
      signal: combined,
      done: () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      },
    };
  }

  async streamChat(request: ChatRequest, handlers: import("../contracts/messages.js").StreamHandlers): Promise<ChatResult> {
    const attempts = Math.max(1, this.maxRetries);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.streamOnce(request, handlers);
      } catch (error) {
        if (isAbort(error) || request.signal?.aborted) throw abortError();
        lastError = error;
        const retryable = isRetryable(error) && attempt < attempts;
        if (!retryable) throw error;
        const delay = this.retryDelayMs ?? computeBackoffMs(attempt, retryAfterOf(error));
        await this.sleepImpl(delay, request.signal);
      }
    }
    throw toError(lastError);
  }

  private async streamOnce(
    request: ChatRequest,
    handlers: import("../contracts/messages.js").StreamHandlers,
  ): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      max_tokens: request.max_tokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
      body.tool_choice = request.tool_choice ?? "auto";
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    const reasoning = request.reasoning ?? this.reasoning;
    if (reasoning) body.reasoning = reasoning;
    const timed = this.timeoutSignal(request.signal);
    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: timed.signal,
      });
    } catch (error) {
      timed.done();
      if (request.signal?.aborted) throw abortError();
      throw networkError(error);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      timed.done();
      throw httpError(response.status, text, response);
    }
    if (!response.body) {
      timed.done();
      throw new GaharError("OpenRouter returned an empty response body", {
        code: "empty_response",
      });
    }
    const acc: StreamAccumulator = {
      content: "",
      reasoning: "",
      toolCalls: [],
      finishReason: null,
      usage: undefined,
      model: undefined,
      generationId: undefined,
      error: undefined,
    };
    try {
      for await (const payload of readSseStream(response.body, request.signal)) {
        const wasDone = payload.trim() === "[DONE]";
        applySsePayload(acc, payload);
        this.emitDeltas(acc, handlers, wasDone);
        if (acc.error !== undefined && acc.error !== null) {
          throw apiErrorFromPayload(acc.error);
        }
      }
    } catch (error) {
      timed.done();
      if (isAbort(error)) throw abortError();
      throw error;
    }
    timed.done();
    if (acc.error !== undefined && acc.error !== null) throw apiErrorFromPayload(acc.error);
    const usage = acc.usage ? (acc.usage as Usage) : undefined;
    if (usage) handlers.onUsage?.(usage);
    handlers.onFinish?.(acc.finishReason);
    return {
      message: {
        role: "assistant",
        content: acc.content.length > 0 ? acc.content : null,
        ...(acc.toolCalls.length > 0 ? { tool_calls: acc.toolCalls } : {}),
        ...(acc.reasoning.length > 0 ? { reasoning: acc.reasoning } : {}),
      },
      finishReason: acc.finishReason,
      ...(usage ? { usage } : {}),
      ...(acc.model ? { model: acc.model } : {}),
      ...(acc.generationId ? { generationId: acc.generationId } : {}),
    };
  }

  private emitDeltas(
    acc: StreamAccumulator,
    handlers: import("../contracts/messages.js").StreamHandlers,
    isDone: boolean,
  ): void {
    const contentLen = this.emittedContent;
    if (acc.content.length > contentLen) {
      handlers.onText?.(acc.content.slice(contentLen));
      this.emittedContent = acc.content.length;
    }
    const reasoningLen = this.emittedReasoning;
    if (acc.reasoning.length > reasoningLen) {
      handlers.onReasoning?.(acc.reasoning.slice(reasoningLen));
      this.emittedReasoning = acc.reasoning.length;
    }
    if (isDone) {
      this.emittedContent = 0;
      this.emittedReasoning = 0;
    }
  }

  private emittedContent = 0;
  private emittedReasoning = 0;

  async listModels(options: { force?: boolean } = {}): Promise<ModelInfo[]> {
    const force = options.force === true;
    if (!force && this.modelsMemo) return this.modelsMemo;
    if (!force && this.configDir) {
      const cached = await readModelCache(this.configDir, this.cacheTtlMs);
      if (cached) {
        this.modelsMemo = cached;
        return cached;
      }
    }
    const payload = await this.requestJson("GET", "/models");
    const models = filterModels(mapModelInfos(payload));
    this.modelsMemo = models;
    if (this.configDir) await writeModelCache(this.configDir, models);
    return models;
  }

  async validateKey(key?: string): Promise<KeyInfo> {
    if (!key && this.keyMemo && Date.now() - this.keyMemo.at < KEY_CACHE_TTL_MS) {
      return this.keyMemo.info;
    }
    const payload = await this.requestJson("GET", "/key", { key });
    const info = mapKeyInfo(payload);
    if (!key) this.keyMemo = { at: Date.now(), info };
    return info;
  }

  private async requestJson(
    method: string,
    path: string,
    options: { key?: string; body?: unknown } = {},
  ): Promise<unknown> {
    const timed = this.timeoutSignal(undefined);
    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(options.key),
        signal: timed.signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      timed.done();
      throw networkError(error);
    }
    const text = await response.text().catch(() => "");
    timed.done();
    if (!response.ok) throw httpError(response.status, text, response);
    if (text.trim().length === 0) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new GaharError("OpenRouter returned a malformed JSON response", {
        code: "malformed_response",
      });
    }
  }
}
