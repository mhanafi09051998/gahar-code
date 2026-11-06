import type { ResolvedConfig } from "./config.js";
import type { GaharEvent } from "./events.js";
import type { Usage } from "./messages.js";
import type { SessionMeta } from "./session.js";
import type { ApprovalHandler } from "./tools.js";

export interface TurnResult {
  text: string;
  usage: Usage;
  durationMs: number;
  finishReason: string | null;
}

export interface AppOptions {
  cwd: string;
  config: ResolvedConfig;
  approvals: ApprovalHandler;
  events: (event: GaharEvent) => void;
  resume?: { type: "latest" } | { type: "id"; id: string };
  model?: string;
}

export interface App {
  readonly sessionId: string;
  readonly meta: SessionMeta;
  getUsage(): Usage;
  runTurn(input: string, signal: AbortSignal): Promise<TurnResult>;
  compact(): Promise<void>;
  undo(): Promise<boolean>;
  setModel(model: string): void;
  close(): Promise<void>;
}
