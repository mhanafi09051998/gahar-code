import type { Usage } from "./messages.js";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface EventBase {
  type: string;
  at: string;
}

export interface InitEvent extends EventBase {
  type: "init";
  sessionId: string;
  model: string;
  permissionMode: string;
  cwd: string;
  version: string;
  resumed: boolean;
  updateAvailable?: { latestVersion: string; releaseUrl: string };
}

export interface TextDeltaEvent extends EventBase {
  type: "text_delta";
  text: string;
}

export interface ReasoningDeltaEvent extends EventBase {
  type: "reasoning_delta";
  text: string;
}

export interface MessageEvent extends EventBase {
  type: "message";
  role: "user" | "assistant";
  text: string;
}

export interface ToolUseEvent extends EventBase {
  type: "tool_use";
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResultEvent extends EventBase {
  type: "tool_result";
  id: string;
  name: string;
  ok: boolean;
  output: string;
  durationMs: number;
  denied?: boolean;
}

export interface ApprovalEvent extends EventBase {
  type: "approval";
  tool: string;
  action: string;
  decision: "allow" | "allow-session" | "deny";
  resource?: string;
}

export interface UsageEvent extends EventBase {
  type: "usage";
  usage: Usage;
  totalCostUsd: number;
}

export interface NoticeEvent extends EventBase {
  type: "notice";
  level: "info" | "warn" | "error";
  message: string;
}

export interface CompactionEvent extends EventBase {
  type: "compaction";
  messagesBefore: number;
  messagesAfter: number;
}

export interface ResultEvent extends EventBase {
  type: "result";
  text: string;
  sessionId: string;
  durationMs: number;
  usage: Usage;
  costUsd: number;
  finishReason: string | null;
  isError: boolean;
}

export interface ErrorEvent extends EventBase {
  type: "error";
  message: string;
  code?: string;
}

export interface UpdateAvailableEvent extends EventBase {
  type: "update_available";
  latestVersion: string;
  releaseUrl: string;
}

export interface UndoEvent extends EventBase {
  type: "undo";
  restored: string[];
}

export type GaharEvent =
  | InitEvent
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | MessageEvent
  | ToolUseEvent
  | ToolResultEvent
  | ApprovalEvent
  | UsageEvent
  | NoticeEvent
  | CompactionEvent
  | ResultEvent
  | ErrorEvent
  | UpdateAvailableEvent
  | UndoEvent;

export type GaharEventType = GaharEvent["type"];

export function createEvent<T extends GaharEvent>(event: Omit<T, "at">): T {
  return { ...event, at: new Date().toISOString() } as T;
}
