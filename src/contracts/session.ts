import type { Usage } from "./messages.js";

export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface SessionSummary extends SessionMeta {
  path: string;
  usage?: Usage;
}
