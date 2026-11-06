import type { ResolvedConfig } from "../contracts/config.js";
import {
  createEvent,
  type GaharEvent,
  type MessageEvent,
  type NoticeEvent,
  type ReasoningDeltaEvent,
  type TextDeltaEvent,
  type ToolResultEvent,
  type ToolUseEvent,
} from "../contracts/events.js";
import type { ChatClient, ChatMessage, ToolCall, ToolDefinition, Usage } from "../contracts/messages.js";
import type { TurnResult } from "../contracts/runner.js";
import type { Tool, ToolContext, ToolRegistry, ToolResult } from "../contracts/tools.js";
import { MAX_ITERATIONS } from "../shared/defaults.js";
import { isAbortError, toErrorMessage } from "../shared/errors.js";
import { truncateMiddle } from "../shared/truncate.js";
import { MAX_TOOL_OUTPUT_CHARS } from "../shared/defaults.js";
import { accumulate, emptyTotals, toUsage, type UsageTotals } from "./usage.js";

export const READ_ONLY_CONCURRENCY = 4;

export interface LoopSession {
  appendMessage(message: ChatMessage): Promise<void>;
  appendUsage?(usage: Usage): Promise<void>;
}

export interface RunTurnDeps {
  client: ChatClient;
  tools: ToolRegistry;
  session: LoopSession;
  config: ResolvedConfig;
  emit: (event: GaharEvent) => void;
  buildToolContext: (signal: AbortSignal) => ToolContext;
  systemPrompt: string;
  model?: string;
  maxIterations?: number;
  maxTokens?: number;
  reasoning?: { effort?: string; max_tokens?: number; exclude?: boolean };
  history?: ChatMessage[];
  usage?: UsageTotals;
  now?: () => number;
}

export interface RunTurnOutcome extends TurnResult {
  messages: ChatMessage[];
  totals: UsageTotals;
  iterations: number;
}

interface ToolOutcome {
  call: ToolCall;
  result: ToolResult;
  durationMs: number;
}

/** Runs one user turn: stream, execute tools, repeat until the model stops. */
export async function runTurn(
  deps: RunTurnDeps,
  input: string,
  signal: AbortSignal,
): Promise<RunTurnOutcome> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const totals = deps.usage ?? emptyTotals();
  const model = deps.model ?? deps.config.model;
  const maxIterations = deps.maxIterations ?? MAX_ITERATIONS;
  const messages: ChatMessage[] = [
    { role: "system", content: deps.systemPrompt },
    ...(deps.history ?? []),
  ];
  const userMessage: ChatMessage = { role: "user", content: input };
  messages.push(userMessage);
  await deps.session.appendMessage(userMessage);
  deps.emit(createEvent<MessageEvent>({ type: "message", role: "user", text: input }));

  const definitions = deps.tools.definitions();
  let text = "";
  let finishReason: string | null = null;
  let iterations = 0;

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      iterations = iteration + 1;
      throwIfAborted(signal);
      const result = await deps.client.streamChat(
        {
          model,
          messages,
          ...(definitions.length > 0 ? { tools: definitions, tool_choice: "auto" as const } : {}),
          max_tokens: deps.maxTokens ?? deps.config.maxTokens,
          ...(deps.reasoning ? { reasoning: deps.reasoning } : {}),
          signal,
        },
        {
          onText: (delta) => {
            text += delta;
            deps.emit(createEvent<TextDeltaEvent>({ type: "text_delta", text: delta }));
          },
          onReasoning: (delta) => {
            deps.emit(createEvent<ReasoningDeltaEvent>({ type: "reasoning_delta", text: delta }));
          },
        },
      );
      finishReason = result.finishReason;
      accumulate(totals, result.usage);
      if (result.usage) await deps.session.appendUsage?.(result.usage);
      const assistant: ChatMessage = {
        role: "assistant",
        content: result.message.content ?? null,
        ...(result.message.tool_calls?.length ? { tool_calls: result.message.tool_calls } : {}),
        ...(result.message.reasoning ? { reasoning: result.message.reasoning } : {}),
      };
      messages.push(assistant);
      await deps.session.appendMessage(assistant);
      if (assistant.content) {
        deps.emit(createEvent<MessageEvent>({ type: "message", role: "assistant", text: assistant.content }));
      }
      const calls = assistant.tool_calls ?? [];
      if (calls.length === 0) break;
      const outcomes = await executeToolCalls(deps, calls, signal);
      for (const outcome of outcomes) {
        const toolMessage: ChatMessage = {
          role: "tool",
          content: outcome.result.output,
          tool_call_id: outcome.call.id,
          name: outcome.call.function.name,
        };
        messages.push(toolMessage);
        await deps.session.appendMessage(toolMessage);
      }
      if (iteration === maxIterations - 1) {
        deps.emit(
          createEvent<NoticeEvent>({
            type: "notice",
            level: "warn",
            message: `Reached the maximum of ${maxIterations} tool iterations; stopping.`,
          }),
        );
      }
    }
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      deps.emit(createEvent<NoticeEvent>({ type: "notice", level: "warn", message: "Turn aborted by user." }));
      throw abortError();
    }
    throw error;
  }

  const usage = toUsage(totals);
  return {
    text,
    usage,
    durationMs: now() - started,
    finishReason,
    messages,
    totals,
    iterations,
  };
}

async function executeToolCalls(
  deps: RunTurnDeps,
  calls: ToolCall[],
  signal: AbortSignal,
): Promise<ToolOutcome[]> {
  const outcomes: ToolOutcome[] = new Array(calls.length);
  const readOnly: number[] = [];
  const mutating: number[] = [];
  calls.forEach((call, index) => {
    const tool = deps.tools.get(call.function.name);
    if (tool?.readOnly) readOnly.push(index);
    else mutating.push(index);
  });
  await runPool(readOnly, READ_ONLY_CONCURRENCY, async (index) => {
    const call = calls[index];
    if (!call) return;
    outcomes[index] = await executeOne(deps, call, signal);
  });
  for (const index of mutating) {
    const call = calls[index];
    if (!call) continue;
    outcomes[index] = await executeOne(deps, call, signal);
  }
  return outcomes;
}

async function runPool(
  items: number[],
  concurrency: number,
  worker: (item: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners: Promise<void>[] = [];
  const size = Math.max(1, Math.min(concurrency, items.length));
  for (let i = 0; i < size; i++) {
    runners.push(
      (async () => {
        for (;;) {
          const next = cursor++;
          const item = items[next];
          if (item === undefined) return;
          await worker(item);
        }
      })(),
    );
  }
  await Promise.all(runners);
}

async function executeOne(deps: RunTurnDeps, call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const name = call.function.name;
  const tool = deps.tools.get(name);
  let args: unknown = {};
  let result: ToolResult;
  if (!tool) {
    result = { ok: false, output: `Unknown tool: ${name}. Available tools: ${deps.tools.list().map((t) => t.name).join(", ")}` };
  } else {
    const parsed = parseArguments(call.function.arguments);
    if (!parsed.ok) {
      result = { ok: false, output: `Invalid JSON arguments for ${name}: ${parsed.error}` };
    } else {
      args = parsed.value;
      deps.emit(createEvent<ToolUseEvent>({ type: "tool_use", id: call.id, name, args }));
      try {
        const ctx = deps.buildToolContext(signal);
        result = await tool.execute(args, ctx);
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw abortError();
        result = { ok: false, output: `Tool ${name} failed: ${toErrorMessage(error)}` };
      }
    }
  }
  const clipped = truncateMiddle(result.output ?? "", MAX_TOOL_OUTPUT_CHARS, "tool output");
  const finalResult: ToolResult = { ...result, output: clipped.text };
  const durationMs = now() - started;
  deps.emit(
    createEvent<ToolResultEvent>({
      type: "tool_result",
      id: call.id,
      name,
      ok: finalResult.ok,
      output: finalResult.output,
      durationMs,
    }),
  );
  return { call, result: finalResult, durationMs };
}

export type ParsedArguments =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export function parseArguments(raw: string | undefined): ParsedArguments {
  const text = (raw ?? "").trim();
  if (text.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("Turn aborted");
  error.name = "AbortError";
  return error;
}

export function toolDefinitions(tools: Tool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}
