import type { ResolvedConfig } from "./config.js";
import type { GaharEvent, TodoItem } from "./events.js";
import type { JsonSchema, ToolDefinition } from "./messages.js";

export type ApprovalAction = "write" | "shell" | "outside-workspace" | "network";

export interface ApprovalRequest {
  tool: string;
  action: ApprovalAction;
  title: string;
  detail?: string;
  resource?: string;
  insideWorkspace?: boolean;
  /** Config, git metadata or hooks: always needs interactive approval. */
  protectedPath?: boolean;
}

export type ApprovalDecision = "allow" | "allow-session" | "deny";

export interface ApprovalHandler {
  request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
}

export type PermissionRequest = ApprovalRequest;

export interface PermissionGate {
  ensure(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<{ allowed: boolean; reason?: string }>;
}

export interface ResolvedPath {
  abs: string;
  input: string;
  inside: boolean;
  exists: boolean;
  type: "file" | "directory" | "missing" | "other";
}

export interface PathGuard {
  resolveForRead(input: string, signal?: AbortSignal): Promise<ResolvedPath>;
  resolveForWrite(input: string, signal?: AbortSignal): Promise<ResolvedPath>;
  relative(abs: string): string;
  isInside(abs: string): boolean;
}

export interface FileRegistry {
  recordRead(absPath: string, content: string): void;
  assertFresh(absPath: string): Promise<void>;
  forget(absPath: string): void;
}

export interface SnapshotStore {
  capture(absPath: string): Promise<void>;
}

export interface TodoStore {
  replace(items: TodoItem[]): void;
  list(): TodoItem[];
}

export interface ToolContext {
  cwd: string;
  config: ResolvedConfig;
  signal: AbortSignal;
  permissions: PermissionGate;
  paths: PathGuard;
  files: FileRegistry;
  snapshots: SnapshotStore;
  todos: TodoStore;
  sessionId: string;
  emit: (event: GaharEvent) => void;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  summary?: string;
  detail?: string;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly readOnly: boolean;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolRegistry {
  list(): Tool[];
  get(name: string): Tool | undefined;
  definitions(): ToolDefinition[];
}
