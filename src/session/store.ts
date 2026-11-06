import { randomUUID } from "node:crypto";
import { appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage, ToolCall, Usage } from "../contracts/messages.js";
import type { SessionMeta, SessionSummary } from "../contracts/session.js";
import {
  atomicWriteFile,
  ensureDir,
  isErrno,
  pathExists,
  readTextFileIfExists,
  removePath,
} from "../shared/fsx.js";
import {
  projectSessionsDir,
  sessionEventsPath,
  sessionMetaPath,
  sessionPath,
  sessionSnapshotsDir,
} from "./project.js";
import { deriveTitle, isPlaceholderTitle } from "./title.js";

export const ABORTED_TOOL_RESULT = "aborted by crash: the tool call never completed";

export type SessionEvent =
  | { type: "meta"; at: string; meta: SessionMeta }
  | { type: "message"; at: string; message: ChatMessage }
  | { type: "usage"; at: string; usage: Usage }
  | { type: "title"; at: string; title: string }
  | { type: "model"; at: string; model: string }
  | { type: "notice"; at: string; message: string };

export interface SessionStoreOptions {
  configDir: string;
  cwd: string;
  id?: string;
  model: string;
  now?: () => Date;
}

export class SessionStore {
  readonly id: string;
  readonly dir: string;
  private meta: SessionMeta;
  private readonly now: () => Date;

  private constructor(id: string, dir: string, meta: SessionMeta, now: () => Date) {
    this.id = id;
    this.dir = dir;
    this.meta = meta;
    this.now = now;
  }

  static async create(options: SessionStoreOptions): Promise<SessionStore> {
    const now = options.now ?? (() => new Date());
    const id = options.id ?? newSessionId(now());
    const dir = sessionPath(options.configDir, options.cwd, id);
    await ensureDir(dir);
    await ensureDir(sessionSnapshotsDir(dir));
    const stamp = now().toISOString();
    const meta: SessionMeta = {
      id,
      title: "New session",
      cwd: options.cwd,
      model: options.model,
      createdAt: stamp,
      updatedAt: stamp,
      messageCount: 0,
    };
    const store = new SessionStore(id, dir, meta, now);
    await store.writeMeta();
    await store.append({ type: "meta", at: stamp, meta });
    return store;
  }

  static async load(configDir: string, cwd: string, id: string): Promise<SessionStore | null> {
    const dir = sessionPath(configDir, cwd, id);
    const raw = await readTextFileIfExists(sessionMetaPath(dir));
    if (raw === null) return null;
    let meta: SessionMeta;
    try {
      meta = JSON.parse(raw) as SessionMeta;
    } catch {
      return null;
    }
    if (!meta || typeof meta.id !== "string") return null;
    return new SessionStore(meta.id, dir, meta, () => new Date());
  }

  getMeta(): SessionMeta {
    return { ...this.meta };
  }

  get eventsPath(): string {
    return sessionEventsPath(this.dir);
  }

  get snapshotsDir(): string {
    return sessionSnapshotsDir(this.dir);
  }

  async append(event: SessionEvent): Promise<void> {
    await ensureDir(this.dir);
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  }

  async appendMessage(message: ChatMessage): Promise<void> {
    await this.append({ type: "message", at: this.now().toISOString(), message });
    if (message.role === "user" || message.role === "assistant") {
      this.meta.messageCount += 1;
    }
    if (message.role === "user" && isPlaceholderTitle(this.meta.title)) {
      const text = typeof message.content === "string" ? message.content : "";
      const title = deriveTitle(text);
      if (!isPlaceholderTitle(title)) await this.setTitle(title);
    }
    await this.touch();
  }

  async setTitle(title: string): Promise<void> {
    this.meta.title = title;
    await this.append({ type: "title", at: this.now().toISOString(), title });
    await this.touch();
  }

  async setModel(model: string): Promise<void> {
    this.meta.model = model;
    await this.append({ type: "model", at: this.now().toISOString(), model });
    await this.touch();
  }

  async appendUsage(usage: Usage): Promise<void> {
    await this.append({ type: "usage", at: this.now().toISOString(), usage });
  }

  private async touch(): Promise<void> {
    this.meta.updatedAt = this.now().toISOString();
    await this.writeMeta();
  }

  private async writeMeta(): Promise<void> {
    await ensureDir(this.dir);
    await atomicWriteFile(sessionMetaPath(this.dir), `${JSON.stringify(this.meta, null, 2)}\n`);
  }

  async readMessages(): Promise<ChatMessage[]> {
    const loaded = await readSessionEvents(this.eventsPath);
    return loaded.messages;
  }

  async readUsage(): Promise<Usage> {
    const loaded = await readSessionEvents(this.eventsPath);
    return loaded.usage;
  }

  async remove(): Promise<void> {
    await removePath(this.dir);
  }
}

export function newSessionId(date: Date): string {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

export interface ParsedEvents {
  messages: ChatMessage[];
  usage: Usage;
  repaired: boolean;
  meta: SessionMeta | null;
}

/** Parses events.jsonl, repairing a trailing tool_calls batch with no results. */
export async function readSessionEvents(eventsPath: string): Promise<ParsedEvents> {
  const text = await readTextFileIfExists(eventsPath);
  const messages: ChatMessage[] = [];
  const usage: Usage = {};
  let meta: SessionMeta | null = null;
  if (text === null) return { messages, usage, repaired: false, meta };
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let event: SessionEvent;
    try {
      event = JSON.parse(line) as SessionEvent;
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    if (event.type === "message" && event.message) messages.push(event.message);
    else if (event.type === "usage" && event.usage) mergeUsage(usage, event.usage);
    else if (event.type === "meta" && event.meta) meta = event.meta;
  }
  const repaired = repairDanglingToolCalls(messages);
  return { messages, usage, repaired, meta };
}

export function mergeUsage(target: Usage, add: Usage): void {
  target.prompt_tokens = (target.prompt_tokens ?? 0) + (add.prompt_tokens ?? 0);
  target.completion_tokens = (target.completion_tokens ?? 0) + (add.completion_tokens ?? 0);
  target.total_tokens = (target.total_tokens ?? 0) + (add.total_tokens ?? 0);
  if (typeof add.cost === "number") target.cost = (target.cost ?? 0) + add.cost;
}

/** Injects synthetic tool results for tool calls that never got one. */
export function repairDanglingToolCalls(messages: ChatMessage[]): boolean {
  let repaired = false;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role !== "assistant" || !message.tool_calls?.length) continue;
    const answered = new Set<string>();
    let j = i + 1;
    for (; j < messages.length; j++) {
      const next = messages[j];
      if (next?.role !== "tool") break;
      if (next.tool_call_id) answered.add(next.tool_call_id);
    }
    const missing = message.tool_calls.filter((call: ToolCall) => !answered.has(call.id));
    if (missing.length === 0) continue;
    const synthetic: ChatMessage[] = missing.map((call) => ({
      role: "tool",
      content: ABORTED_TOOL_RESULT,
      tool_call_id: call.id,
      name: call.function.name,
    }));
    messages.splice(j, 0, ...synthetic);
    repaired = true;
    i = j + synthetic.length - 1;
  }
  return repaired;
}

export async function listSessions(configDir: string, cwd: string): Promise<SessionSummary[]> {
  const sessionsRoot = projectSessionsDir(configDir, cwd);
  let entries: string[];
  try {
    entries = await readdir(sessionsRoot);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
  const summaries: SessionSummary[] = [];
  for (const entry of entries) {
    const sessionDirPath = join(sessionsRoot, entry);
    const raw = await readTextFileIfExists(sessionMetaPath(sessionDirPath));
    if (raw === null) continue;
    try {
      const meta = JSON.parse(raw) as SessionMeta;
      if (!meta || typeof meta.id !== "string") continue;
      const parsed = await readSessionEvents(sessionEventsPath(sessionDirPath));
      summaries.push({ ...meta, path: sessionDirPath, usage: parsed.usage });
    } catch {}
  }
  summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return summaries;
}

export async function latestSessionId(configDir: string, cwd: string): Promise<string | null> {
  const sessions = await listSessions(configDir, cwd);
  return sessions[0]?.id ?? null;
}

export async function sessionExists(configDir: string, cwd: string, id: string): Promise<boolean> {
  return pathExists(sessionMetaPath(sessionPath(configDir, cwd, id)));
}

export async function removeSession(configDir: string, cwd: string, id: string): Promise<void> {
  await removePath(sessionPath(configDir, cwd, id));
}
