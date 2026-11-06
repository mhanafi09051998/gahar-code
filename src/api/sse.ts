import type { ToolCall } from "../contracts/messages.js";
import { abortError } from "./errors.js";

export interface SseEvent {
  data: string;
  event?: string;
}

/** Splits a byte/char stream into SSE events, tolerating any chunk boundary. */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    return this.drain(false);
  }

  /** Flushes a trailing event that was not terminated by a blank line. */
  finish(): SseEvent[] {
    return this.drain(true);
  }

  private drain(flush: boolean): SseEvent[] {
    const events: SseEvent[] = [];
    let start = 0;
    for (;;) {
      const newline = this.buffer.indexOf("\n", start);
      if (newline === -1) break;
      const rawLine = this.buffer.slice(start, newline);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.length === 0) {
        const block = this.buffer.slice(0, start);
        this.buffer = this.buffer.slice(newline + 1);
        start = 0;
        const parsed = parseEventBlock(block);
        if (parsed) events.push(parsed);
        continue;
      }
      start = newline + 1;
    }
    if (flush && this.buffer.trim().length > 0) {
      const block = this.buffer;
      this.buffer = "";
      const parsed = parseEventBlock(block);
      if (parsed) events.push(parsed);
    }
    return events;
  }
}

export function parseEventBlock(block: string): SseEvent | null {
  const dataLines: string[] = [];
  let eventName: string | undefined;
  const lines = block.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    else if (field === "event") eventName = value;
  }
  if (dataLines.length === 0) return null;
  const event: SseEvent = { data: dataLines.join("\n") };
  if (eventName !== undefined) event.event = eventName;
  return event;
}

/**
 * Streams decoded SSE payload strings (never throws on split/malformed input).
 * `onChunk` runs for every received chunk, including keep-alive comments.
 */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  onChunk?: () => void,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let finished = false;
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const step = await reader.read();
      if (step.done) {
        finished = true;
        break;
      }
      onChunk?.();
      const textChunk = decoder.decode(step.value, { stream: true });
      for (const event of parser.push(textChunk)) yield event.data;
    }
    const tail = decoder.decode();
    if (tail.length > 0) {
      for (const event of parser.push(tail)) yield event.data;
    }
    for (const event of parser.finish()) yield event.data;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!finished) {
      await reader.cancel().catch(() => undefined);
    }
  }
  if (signal?.aborted) throw abortError();
}

export interface StreamAccumulator {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Record<string, unknown> | undefined;
  model: string | undefined;
  generationId: string | undefined;
  error: unknown;
}

export function newAccumulator(): StreamAccumulator {
  return {
    content: "",
    reasoning: "",
    toolCalls: [],
    finishReason: null,
    usage: undefined,
    model: undefined,
    generationId: undefined,
    error: undefined,
  };
}

interface DeltaFragment {
  content?: string | null;
  reasoning?: string | null;
  reasoning_details?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function reasoningText(delta: DeltaFragment, details: unknown): string {
  const parts: string[] = [];
  const direct = asString(delta.reasoning);
  if (direct) parts.push(direct);
  const list = Array.isArray(details) ? details : isRecord(details) ? [details] : [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const text = asString(entry.text) ?? asString(entry.summary) ?? asString(entry.content);
    if (text) parts.push(text);
  }
  return parts.join("");
}

function toolCallAt(list: ToolCall[], index: number): ToolCall {
  const existing = list[index];
  if (existing) return existing;
  const created: ToolCall = { id: "", type: "function", function: { name: "", arguments: "" } };
  list[index] = created;
  return created;
}

/** Applies one decoded SSE payload to the accumulator. Returns false for [DONE]. */
export function applySsePayload(acc: StreamAccumulator, payload: string): boolean {
  const trimmed = payload.trim();
  if (trimmed === "[DONE]") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return true;
  }
  if (!isRecord(parsed)) return true;
  const errorRecord = parsed.error;
  if (errorRecord !== undefined && errorRecord !== null) {
    acc.error = errorRecord;
    return true;
  }
  const model = asString(parsed.model);
  if (model) acc.model ??= model;
  const id = asString(parsed.id);
  if (id) acc.generationId ??= id;
  const usage = parsed.usage;
  if (isRecord(usage)) acc.usage = usage;
  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const choice = choices[0];
  if (!isRecord(choice)) return true;
  const finish = asString(choice.finish_reason);
  if (finish) acc.finishReason = finish;
  const delta = choice.delta;
  if (!isRecord(delta)) return true;
  const fragment = delta as DeltaFragment;
  const content = asString(fragment.content);
  if (content) acc.content += content;
  const reasoning = reasoningText(fragment, fragment.reasoning_details);
  if (reasoning) acc.reasoning += reasoning;
  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  for (const rawCall of toolCalls) {
    if (!isRecord(rawCall)) continue;
    const rawIndex = rawCall.index;
    const index = typeof rawIndex === "number" ? rawIndex : acc.toolCalls.length;
    const call = toolCallAt(acc.toolCalls, index);
    const callId = asString(rawCall.id);
    if (callId) call.id = callId;
    const fn = rawCall.function;
    if (!isRecord(fn)) continue;
    const name = asString(fn.name);
    if (name) call.function.name = name;
    const args = asString(fn.arguments);
    if (args) call.function.arguments += args;
  }
  return true;
}
