import {
  buildSystemPromptWithInstructions,
  compact,
  needsCompaction,
  runTurn,
} from "./agent/index.js";
import { OpenRouterClient } from "./api/index.js";
import { MemoryFileRegistry } from "./app/files.js";
import { createRegistry } from "./app/gate.js";
import { openSession, requireApiKey } from "./app/session.js";
import {
  type CompactionEvent,
  createEvent,
  type NoticeEvent,
  type TodoItem,
  type UndoEvent,
  type UsageEvent,
} from "./contracts/events.js";
import type { ModelInfo, Usage } from "./contracts/messages.js";
import type { App, AppOptions } from "./contracts/runner.js";
import type { PathGuard, ToolContext } from "./contracts/tools.js";
import { createPathGuard } from "./security/paths.js";
import { createPermissionGate } from "./security/permissions.js";
import { mergeUsage, UndoManager } from "./session/index.js";
import { GaharError } from "./shared/errors.js";
import { builtinTools } from "./tools/registry.js";

/** Wires client, tools, permissions, session and undo into one runnable app. */
export async function createApp(opts: AppOptions): Promise<App> {
  const { config, cwd } = opts;
  const apiKey = requireApiKey(config);
  const emit = opts.events;
  const notice = (message: string, level: NoticeEvent["level"] = "info") =>
    emit(createEvent<NoticeEvent>({ type: "notice", level, message }));
  let model = opts.model ?? config.model;
  const opened = await openSession(opts, model, notice);
  const { store } = opened;
  let history = opened.history;
  const sessionUsage: Usage = { ...opened.usage };
  const client = new OpenRouterClient({
    apiKey,
    baseUrl: config.baseUrl,
    configDir: config.configDir,
  });
  const paths: PathGuard = createPathGuard(cwd);
  const gate = createPermissionGate({
    mode: config.permissionMode,
    handler: opts.approvals,
    interactive: true,
  });
  const registry = createRegistry(builtinTools, { gate, cwd, secrets: [apiKey], emit });
  const files = new MemoryFileRegistry();
  const undo = new UndoManager({ snapshotsDir: store.snapshotsDir, cwd });
  const latestTurn = (await undo.listTurns())[0] ?? 0;
  while (undo.turn < latestTurn) undo.beginTurn();
  let todos: TodoItem[] = [];
  let pending: Promise<void> = Promise.resolve();
  let modelInfo: Promise<ModelInfo | null> | null = null;
  let busy = false;

  const toolContext = (signal: AbortSignal): ToolContext => ({
    cwd,
    config,
    signal,
    permissions: gate,
    paths,
    files,
    snapshots: { capture: (absPath) => undo.capture(absPath) },
    todos: { replace: (items) => (todos = [...items]), list: () => [...todos] },
    sessionId: store.id,
    emit,
  });

  const currentModelInfo = (): Promise<ModelInfo | null> => {
    modelInfo ??= client
      .listModels()
      .then((models) => models.find((info) => info.id === model) ?? null)
      .catch(() => null);
    return modelInfo;
  };

  const compactHistory = async (force: boolean, signal?: AbortSignal): Promise<void> => {
    if (!force) {
      if (!config.contextCompaction || history.length === 0) return;
      if (!needsCompaction(history, await currentModelInfo(), config.maxTokens)) return;
    }
    const result = await compact(client, history, model, signal ? { signal } : {});
    if (!result.compacted) {
      if (force)
        notice(`Compaction skipped: ${result.error ?? "history is already short"}`, "warn");
      return;
    }
    history = result.messages;
    emit(
      createEvent<CompactionEvent>({
        type: "compaction",
        messagesBefore: result.messagesBefore,
        messagesAfter: result.messagesAfter,
      }),
    );
  };

  return {
    get sessionId() {
      return store.id;
    },
    get meta() {
      return store.getMeta();
    },
    getUsage: () => ({ ...sessionUsage }),
    async runTurn(input, signal) {
      if (busy) throw new GaharError("A turn is already running", { code: "busy" });
      busy = true;
      try {
        await pending;
        await compactHistory(false, signal);
        undo.beginTurn();
        const systemPrompt = await buildSystemPromptWithInstructions({
          cwd,
          configDir: config.configDir,
          model,
          permissionMode: config.permissionMode,
          toolNames: registry.list().map((tool) => tool.name),
        });
        const outcome = await runTurn(
          {
            client,
            tools: registry,
            session: store,
            config,
            emit,
            buildToolContext: toolContext,
            systemPrompt,
            model,
            history,
          },
          input,
          signal,
        );
        history = outcome.messages.filter((message) => message.role !== "system");
        mergeUsage(sessionUsage, outcome.usage);
        emit(
          createEvent<UsageEvent>({
            type: "usage",
            usage: outcome.usage,
            totalCostUsd: sessionUsage.cost ?? 0,
          }),
        );
        const { text, usage, durationMs, finishReason } = outcome;
        return { text, usage, durationMs, finishReason };
      } catch (error) {
        history = await store.readMessages();
        throw error;
      } finally {
        await undo.prune().catch(() => undefined);
        busy = false;
      }
    },
    compact: () => compactHistory(true),
    async undo() {
      const last = await undo.undoLast();
      if (last === null || last.restored.length === 0) return false;
      for (const abs of last.restored) files.forget(abs);
      emit(
        createEvent<UndoEvent>({
          type: "undo",
          restored: last.restored.map((abs) => paths.relative(abs)),
        }),
      );
      return true;
    },
    setModel(next) {
      model = next;
      modelInfo = null;
      pending = pending.then(() => store.setModel(next)).catch(() => undefined);
    },
    async close() {
      await pending;
    },
  };
}
