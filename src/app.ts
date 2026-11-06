import {
  accumulate,
  buildSystemPromptWithInstructions,
  compact,
  emptyTotals,
  needsCompaction,
  runTurn,
  toUsage,
} from "./agent/index.js";
import { OpenRouterClient } from "./api/index.js";
import { observeGate, redactToolOutput } from "./app/gate.js";
import { openSession } from "./app/session.js";
import { requireApiKey, resolveApiKey } from "./auth/index.js";
import {
  type CompactionEvent,
  createEvent,
  type NoticeEvent,
  type UndoEvent,
} from "./contracts/events.js";
import type { ModelInfo } from "./contracts/messages.js";
import type { App, AppOptions } from "./contracts/runner.js";
import type { ToolContext } from "./contracts/tools.js";
import { createPathGuard } from "./security/paths.js";
import { createPermissionGate } from "./security/permissions.js";
import { UndoManager } from "./session/index.js";
import { GaharError } from "./shared/errors.js";
import { builtinTools, createDefaultRegistry } from "./tools/registry.js";
import { DefaultFileRegistry, MemoryTodoStore } from "./tools/stores.js";

/** Wires client, tools, permissions, session and undo into one runnable app. */
export async function createApp(opts: AppOptions): Promise<App> {
  const { config, cwd } = opts;
  const apiKey = requireApiKey(resolveApiKey(config));
  const emit = opts.events;
  const notice = (message: string, level: NoticeEvent["level"] = "info") =>
    emit(createEvent<NoticeEvent>({ type: "notice", level, message }));
  let model = opts.model ?? config.model;
  const opened = await openSession(opts, model, notice);
  const { store } = opened;
  let history = opened.history;
  const sessionUsage = accumulate(emptyTotals(), opened.usage);
  const client = new OpenRouterClient({
    apiKey,
    baseUrl: config.baseUrl,
    configDir: config.configDir,
  });
  const paths = createPathGuard(cwd);
  const permissions = observeGate(
    createPermissionGate({
      mode: config.permissionMode,
      handler: opts.approvals,
      interactive: true,
    }),
    emit,
  );
  const registry = createDefaultRegistry(redactToolOutput(builtinTools, [apiKey]));
  const files = new DefaultFileRegistry();
  const todos = new MemoryTodoStore();
  const undo = new UndoManager({ snapshotsDir: store.snapshotsDir, cwd });
  let pending: Promise<void> = Promise.resolve();
  let modelInfo: Promise<ModelInfo | null> | null = null;
  let busy = false;

  const toolContext = (signal: AbortSignal): ToolContext => ({
    cwd,
    config,
    signal,
    permissions,
    paths,
    files,
    snapshots: undo,
    todos,
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
    getUsage: () => toUsage(sessionUsage),
    async runTurn(input, signal) {
      if (busy) throw new GaharError("A turn is already running", { code: "busy" });
      busy = true;
      try {
        await pending;
        await compactHistory(false, signal);
        await undo.beginTurn();
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
            modelInfo: await currentModelInfo(),
            history,
            usage: sessionUsage,
          },
          input,
          signal,
        );
        history = outcome.messages.filter((message) => message.role !== "system");
        const { text, usage, durationMs, finishReason } = outcome;
        return { text, usage, durationMs, finishReason };
      } catch (error) {
        history = await store.readMessages();
        throw error;
      } finally {
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
