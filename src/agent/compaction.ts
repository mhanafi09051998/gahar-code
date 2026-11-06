import type { ChatClient, ChatMessage, ModelInfo } from "../contracts/messages.js";
import { toErrorMessage } from "../shared/errors.js";
import { approxTokens } from "../shared/truncate.js";

export const COMPACTION_THRESHOLD = 0.8;
export const KEEP_RECENT_MESSAGES = 4;
export const DEFAULT_CONTEXT_LENGTH = 128000;

export function estimateMessageTokens(message: ChatMessage): number {
  let total = approxTokens(message.content ?? "");
  if (message.reasoning) total += approxTokens(message.reasoning);
  for (const call of message.tool_calls ?? []) {
    total += approxTokens(call.function.name) + approxTokens(call.function.arguments) + 8;
  }
  return total + 4;
}

export function estimateTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/** True when the history is above 80% of the usable context window. */
export function needsCompaction(
  messages: ChatMessage[],
  modelInfo: ModelInfo | null | undefined,
  maxTokens: number,
): boolean {
  const contextLength = modelInfo?.context_length ?? DEFAULT_CONTEXT_LENGTH;
  const usable = Math.max(1, contextLength - Math.max(0, maxTokens));
  return estimateTokens(messages) > usable * COMPACTION_THRESHOLD;
}

export interface CompactionResult {
  messages: ChatMessage[];
  compacted: boolean;
  messagesBefore: number;
  messagesAfter: number;
  error?: string;
}

const SUMMARY_PROMPT = `Summarize the conversation so far for another assistant that will continue the work.
Keep: the user's goals and constraints, decisions made, files inspected or changed (with paths), commands run and their outcomes, open questions and next steps.
Be concise and factual. Do not invent anything. Output only the summary.`;

/** Summarizes older messages; on any failure returns the original history. */
export async function compact(
  client: ChatClient,
  messages: ChatMessage[],
  model: string,
  options: { keepRecent?: number; signal?: AbortSignal } = {},
): Promise<CompactionResult> {
  const keepRecent = options.keepRecent ?? KEEP_RECENT_MESSAGES;
  const before = messages.length;
  const unchanged: CompactionResult = {
    messages,
    compacted: false,
    messagesBefore: before,
    messagesAfter: before,
  };
  const system = messages.filter((message) => message.role === "system");
  const rest = messages.filter((message) => message.role !== "system");
  const split = recentStart(rest, keepRecent);
  if (split <= 1) return unchanged;
  const older = rest.slice(0, split);
  const recent = rest.slice(split);
  try {
    const result = await client.streamChat(
      {
        model,
        messages: [
          { role: "system", content: SUMMARY_PROMPT },
          { role: "user", content: renderTranscript(older) },
        ],
        max_tokens: 2000,
        signal: options.signal,
      },
      {},
    );
    const summary = (result.message.content ?? "").trim();
    if (summary.length === 0) return { ...unchanged, error: "empty summary" };
    const block: ChatMessage = {
      role: "user",
      content: `[Conversation summary — earlier messages were compacted]\n${summary}`,
    };
    const next = [...system, block, ...recent];
    return {
      messages: next,
      compacted: true,
      messagesBefore: before,
      messagesAfter: next.length,
    };
  } catch (error) {
    return { ...unchanged, error: toErrorMessage(error) };
  }
}

/** Index where the kept tail begins, moved back so it never starts with orphaned tool results. */
function recentStart(messages: ChatMessage[], keepRecent: number): number {
  let start = Math.max(0, messages.length - keepRecent);
  while (start > 0 && messages[start]?.role === "tool") start -= 1;
  return start;
}

export function renderTranscript(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const content = (message.content ?? "").trim();
    if (message.role === "tool") {
      lines.push(`[tool ${message.name ?? message.tool_call_id ?? ""}] ${clip(content, 600)}`);
      continue;
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      const calls = message.tool_calls
        .map((call) => `${call.function.name}(${clip(call.function.arguments, 300)})`)
        .join(", ");
      lines.push(`[assistant] ${clip(content, 600)} [called: ${calls}]`);
      continue;
    }
    lines.push(`[${message.role}] ${clip(content, 1200)}`);
  }
  return lines.join("\n");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
