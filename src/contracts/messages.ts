export type JsonSchema = Record<string, unknown>;

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning?: string;
  reasoning_details?: unknown;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number; [key: string]: unknown } | null;
  completion_tokens_details?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface ModelPricing {
  prompt?: string;
  completion?: string;
  request?: string;
  image?: string;
  [key: string]: string | undefined;
}

export interface ModelInfo {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: ModelPricing;
  supported_parameters?: string[];
  architecture?: Record<string, unknown>;
  top_provider?: Record<string, unknown>;
}

export interface KeyInfo {
  label?: string;
  limit?: number | null;
  usage?: number;
  limit_remaining?: number | null;
  is_free_tier?: boolean;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  max_tokens?: number;
  temperature?: number;
  reasoning?: { effort?: string; max_tokens?: number; exclude?: boolean };
  signal?: AbortSignal;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface StreamHandlers {
  onText?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onToolCall?: (delta: ToolCallDelta) => void;
  onUsage?: (usage: Usage) => void;
  onFinish?: (reason: string | null) => void;
}

export interface ChatResult {
  message: ChatMessage;
  finishReason: string | null;
  usage?: Usage;
  model?: string;
  generationId?: string;
}

export interface ChatClient {
  streamChat(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResult>;
  listModels(): Promise<ModelInfo[]>;
  validateKey(key?: string): Promise<KeyInfo>;
}
