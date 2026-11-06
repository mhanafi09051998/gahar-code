import { abortError } from "../api/errors.js";
import type { ResolvedConfig } from "../contracts/config.js";
import {
  createEvent,
  type GaharEvent,
  type MessageEvent,
  type NoticeEvent,
  type ReasoningDeltaEvent,
  type TextDeltaEvent,
  type UsageEvent,
} from "../contracts/events.js";
import type {
  ChatClient,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ModelInfo,
  ToolCall,
  ToolDefinition,
  Usage,
} from "../contracts/messages.js";
import type { TurnResult } from "../contracts/runner.js";
import type { Tool, ToolContext, ToolRegistry } from "../contracts/tools.js";
import { MAX_ITERATIONS } from "../shared/defaults.js";
import { isAbortError } from "../shared/errors.js";
import { executeToolCalls } from "./tool-exec.js";
import { accumulate, emptyTotals, toUsage, type UsageTotals } from "./usage.js";

export const ABORTED_BY_USER_RESULT = "aborted by user: the tool call did not complete";

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
  /** Pricing used to estimate cost when the provider omits usage.cost. */
  modelInfo?: ModelInfo | null;
  maxIterations?: number;
  maxTokens?: number;
  reasoning?: ChatRequest["reasoning"];
  /** Prior conversation (without the system message). */
  history?: ChatMessage[];
  /** Session-wide totals; this turn's usage is added into it as well. */
  usage?: UsageTotals;
  now?: () => number;
}

export interface RunTurnOutcome extends TurnResult {
  /** Full conversation sent to the model, including the system message. */
  messages: ChatMessage[];
  /** Totals for this turn only. */
  totals: UsageTotals;
  iterations: number;
}

/** Runs one user turn: stream, execute tools, repeat until the model stops calling tools. */
export async function runTurn(
  deps: RunTurnDeps,
  input: string,
  signal: AbortSignal,
): Promise<RunTurnOutcome> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const turnTotals = emptyTotals();
  const maxIterations = deps.maxIterations ?? MAX_ITERATIONS;
  const messages: ChatMessage[] = [
    { role: "system", content: deps.systemPrompt },
    ...(deps.history ?? []),
  ];
  const record = async (message: ChatMessage): Promise<void> => {
    messages.push(message);
    await deps.session.appendMessage(message);
  };
  await record({ role: "user", content: input });
  deps.emit(createEvent<MessageEvent>({ type: "message", role: "user", text: input }));

  let text = "";
  let finishReason: string | null = null;
  let iterations = 0;
  let pendingCalls: ToolCall[] = [];
  const onText = (delta: string): void => {
    text += delta;
  };

  try {
    while (iterations < maxIterations) {
      iterations += 1;
      if (signal.aborted) throw abortError();
      const result = await streamOnce(deps, messages, signal, onText);
      finishReason = result.finishReason;
      await recordUsage(deps, turnTotals, result.usage);
      const assistant = toAssistantMessage(result);
      pendingCalls = assistant.tool_calls ?? [];
      await record(assistant);
      if (assistant.content) {
        deps.emit(
          createEvent<MessageEvent>({
            type: "message",
            role: "assistant",
            text: assistant.content,
          }),
        );
      }
      if (pendingCalls.length === 0) break;
      const outcomes = await executeToolCalls({ ...deps, now }, pendingCalls, signal);
      for (const { call, result: toolResult } of outcomes) {
        await record(toolMessage(call, toolResult.output));
      }
      pendingCalls = [];
      if (iterations === maxIterations) {
        notice(deps, `Reached the maximum of ${maxIterations} tool iterations; stopping.`);
      }
    }
  } catch (error) {
    if (!isAbortError(error) && !signal.aborted) throw error;
    for (const call of pendingCalls) await record(toolMessage(call, ABORTED_BY_USER_RESULT));
    notice(deps, "Turn aborted by user.");
    throw abortError();
  }

  return {
    text,
    usage: toUsage(turnTotals),
    durationMs: now() - started,
    finishReason,
    messages,
    totals: turnTotals,
    iterations,
  };
}

function streamOnce(
  deps: RunTurnDeps,
  messages: ChatMessage[],
  signal: AbortSignal,
  onText: (delta: string) => void,
): Promise<ChatResult> {
  const definitions = deps.tools.definitions();
  return deps.client.streamChat(
    {
      model: deps.model ?? deps.config.model,
      messages: [...messages],
      ...(definitions.length > 0 ? { tools: definitions, tool_choice: "auto" as const } : {}),
      max_tokens: deps.maxTokens ?? deps.config.maxTokens,
      ...(deps.reasoning ? { reasoning: deps.reasoning } : {}),
      signal,
    },
    {
      onText: (delta) => {
        onText(delta);
        deps.emit(createEvent<TextDeltaEvent>({ type: "text_delta", text: delta }));
      },
      onReasoning: (delta) => {
        deps.emit(createEvent<ReasoningDeltaEvent>({ type: "reasoning_delta", text: delta }));
      },
    },
  );
}

async function recordUsage(
  deps: RunTurnDeps,
  turnTotals: UsageTotals,
  usage: Usage | undefined,
): Promise<void> {
  if (!usage) return;
  const options = { model: deps.modelInfo ?? null };
  accumulate(turnTotals, usage, options);
  if (deps.usage) accumulate(deps.usage, usage, options);
  await deps.session.appendUsage?.(usage);
  const totalCostUsd = (deps.usage ?? turnTotals).costUsd;
  deps.emit(createEvent<UsageEvent>({ type: "usage", usage, totalCostUsd }));
}

function toAssistantMessage(result: ChatResult): ChatMessage {
  const calls = result.message.tool_calls ?? [];
  return {
    role: "assistant",
    content: result.message.content ?? null,
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
    ...(result.message.reasoning ? { reasoning: result.message.reasoning } : {}),
  };
}

function toolMessage(call: ToolCall, content: string): ChatMessage {
  return { role: "tool", content, tool_call_id: call.id, name: call.function.name };
}

function notice(deps: RunTurnDeps, message: string): void {
  deps.emit(createEvent<NoticeEvent>({ type: "notice", level: "warn", message }));
}

export function toolDefinitions(tools: Tool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}
