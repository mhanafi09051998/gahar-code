import type {
  ChatClient,
  ChatRequest,
  ChatResult,
  KeyInfo,
  ModelInfo,
  StreamHandlers,
} from "../contracts/messages.js";
import { DEFAULT_BASE_URL, HTTP_REFERER, X_TITLE } from "../shared/defaults.js";
import { GaharError, isAbortError } from "../shared/errors.js";
import { abortError, computeBackoffMs, MAX_ATTEMPTS, sleep } from "./errors.js";
import { httpError, isRetryable, networkError, retryAfterOf, toError } from "./http.js";
import {
  filterModels,
  mapKeyInfo,
  mapModelInfos,
  readModelCache,
  writeModelCache,
} from "./models.js";
import {
  consumeChatStream,
  createDeadline,
  deadlineError,
  finishResult,
  STREAM_IDLE_TIMEOUT_MS,
} from "./stream.js";

export type ReasoningOptions = NonNullable<ChatRequest["reasoning"]>;

export interface OpenRouterClientOptions {
  apiKey: string;
  baseUrl?: string;
  configDir?: string;
  fetchImpl?: typeof fetch;
  reasoning?: ReasoningOptions;
  maxRetries?: number;
  retryDelayMs?: number;
  cacheTtlMs?: number;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Total request timeout; unset means no limit. */
  timeoutMs?: number;
  /** Abort and retry a chat stream after this long without any bytes; 0 disables it. */
  idleTimeoutMs?: number;
}

const KEY_CACHE_TTL_MS = 5 * 60 * 1000;

export class OpenRouterClient implements ChatClient {
  private readonly baseUrl: string;
  private readonly configDir: string | undefined;
  private readonly doFetch: typeof fetch;
  private readonly apiKey: string;
  private readonly reasoning: ReasoningOptions | undefined;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number | undefined;
  private readonly cacheTtlMs: number | undefined;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly timeoutMs: number | undefined;
  private readonly idleTimeoutMs: number;
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
    this.idleTimeoutMs = options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  }

  private headers(key?: string): Record<string, string> {
    return {
      Authorization: `Bearer ${key ?? this.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": HTTP_REFERER,
      "X-Title": X_TITLE,
    };
  }

  /** Streams a completion, retrying transient failures only before any output was emitted. */
  async streamChat(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResult> {
    const attempts = Math.max(1, this.maxRetries);
    let emitted = false;
    const tracked: StreamHandlers = {
      ...handlers,
      onText: (text) => {
        emitted = true;
        handlers.onText?.(text);
      },
      onReasoning: (text) => {
        emitted = true;
        handlers.onReasoning?.(text);
      },
    };
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.streamOnce(request, tracked);
      } catch (error) {
        if (isAbortError(error) || request.signal?.aborted) throw abortError();
        lastError = error;
        if (emitted || !isRetryable(error) || attempt >= attempts) throw toError(error);
        const delay = this.retryDelayMs ?? computeBackoffMs(attempt, retryAfterOf(error));
        await this.sleepImpl(delay, request.signal);
      }
    }
    throw toError(lastError);
  }

  private requestBody(request: ChatRequest): Record<string, unknown> {
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
    return body;
  }

  private async streamOnce(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResult> {
    const deadline = createDeadline(request.signal, {
      totalMs: this.timeoutMs,
      idleMs: this.idleTimeoutMs,
    });
    try {
      const response = await this.fetchOrThrow(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.requestBody(request)),
        signal: deadline.signal,
      });
      if (!response.body) {
        throw new GaharError("OpenRouter returned an empty response body", {
          code: "empty_response",
        });
      }
      const acc = await consumeChatStream(response.body, deadline, handlers);
      return finishResult(acc, handlers);
    } catch (error) {
      throw deadlineError(deadline, request.signal, error);
    } finally {
      deadline.done();
    }
  }

  private async fetchOrThrow(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.doFetch(url, init);
    } catch (error) {
      if (init.signal?.aborted) throw abortError();
      throw networkError(error);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw httpError(response.status, text, response);
    }
    return response;
  }

  async listModels(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
    const force = options.force === true;
    if (!force && this.modelsMemo) return this.modelsMemo;
    if (!force && this.configDir) {
      const cached = await readModelCache(this.configDir, this.cacheTtlMs);
      if (cached) {
        this.modelsMemo = cached;
        return cached;
      }
    }
    const payload = await this.requestJson("/models", { signal: options.signal });
    const models = filterModels(mapModelInfos(payload));
    this.modelsMemo = models;
    if (this.configDir) await writeModelCache(this.configDir, models);
    return models;
  }

  async validateKey(key?: string, signal?: AbortSignal): Promise<KeyInfo> {
    if (!key && this.keyMemo && Date.now() - this.keyMemo.at < KEY_CACHE_TTL_MS) {
      return this.keyMemo.info;
    }
    const payload = await this.requestJson("/key", { key, signal });
    const info = mapKeyInfo(payload);
    if (!key) this.keyMemo = { at: Date.now(), info };
    return info;
  }

  private async requestJson(
    path: string,
    options: { key?: string | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<unknown> {
    const deadline = createDeadline(options.signal, { totalMs: this.timeoutMs });
    let text: string;
    try {
      const response = await this.fetchOrThrow(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: this.headers(options.key),
        signal: deadline.signal,
      });
      text = await response.text();
    } catch (error) {
      const mapped = deadlineError(deadline, options.signal, error);
      if (mapped !== error) throw mapped;
      if (isAbortError(error) || options.signal?.aborted) throw abortError();
      if (error instanceof GaharError) throw error;
      throw networkError(error);
    } finally {
      deadline.done();
    }
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
