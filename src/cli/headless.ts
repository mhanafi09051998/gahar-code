import type { App, AppOptions, TurnResult } from "../contracts/runner.js";
import type { GaharEvent } from "../contracts/events.js";
import { GaharError, isAbortError, toErrorMessage } from "../shared/errors.js";
import { VERSION } from "../shared/version.js";
import { JsonEventWriter } from "./json-output.js";
import { Renderer } from "../ui/render.js";
import { EXIT_AUTH_ERROR, EXIT_INTERRUPT } from "./args.js";
import type { Writable } from "./env.js";

export interface HeadlessOptions {
  prompt: string;
  cwd: string;
  json: boolean;
  quiet?: boolean;
  columns?: number;
  color: boolean;
  stdout: Writable;
  stderr: Writable;
  createApp: (options: AppOptions) => Promise<App>;
  appOptions: Omit<AppOptions, "cwd" | "events">;
  /** Wires process signals; returns a disposer. */
  installSignals?: (controller: AbortController) => () => void;
}

export interface HeadlessOutcome {
  exitCode: number;
  text: string;
  result: TurnResult | null;
  events: GaharEvent[];
}

export async function runHeadless(options: HeadlessOptions): Promise<HeadlessOutcome> {
  const writer = new JsonEventWriter({ stdout: options.stdout, enabled: options.json });
  const renderer = new Renderer({
    stderr: options.stderr,
    stdout: options.stdout,
    color: options.color && !options.json,
    json: options.json,
    columns: options.columns,
    quiet: options.quiet ?? true,
  });
  const events: GaharEvent[] = [];
  const controller = new AbortController();
  const disposeSignals = options.installSignals?.(controller);

  let app: App | null = null;
  try {
    app = await options.createApp({
      cwd: options.cwd,
      ...options.appOptions,
      events: (event) => {
        events.push(event);
        writer.emit(event);
        if (!options.json) display(event, renderer);
      },
    });
    writer.emit(initEvent(app, options));
    const result = await app.runTurn(options.prompt, controller.signal);
    if (app !== null) {
      writer.emit({
        type: "result",
        at: new Date().toISOString(),
        text: result.text,
        sessionId: app.sessionId,
        durationMs: result.durationMs,
        usage: result.usage,
        costUsd: typeof result.usage.cost === "number" ? result.usage.cost : 0,
        finishReason: result.finishReason,
        isError: false,
      });
    }
    if (!options.json) {
      if (!renderer.isJson) renderer.line("");
      renderer.usageLine({
        total: result.usage.total_tokens,
        cost: typeof result.usage.cost === "number" ? result.usage.cost : undefined,
        elapsedMs: result.durationMs,
      });
    }
    if (!options.json && result.text !== "") {
      options.stdout.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
    }
    return { exitCode: 0, text: result.text, result, events };
  } catch (error) {
    return { exitCode: failureExitCode(error), text: "", result: null, events };
  } finally {
    disposeSignals?.();
    if (app !== null) {
      try {
        await app.close();
      } catch {
        // Closing a broken session must not mask the original failure.
      }
    }
  }
}

function initEvent(app: App, options: HeadlessOptions): GaharEvent {
  const resume: unknown = options.appOptions.resume;
  return {
    type: "init",
    at: new Date().toISOString(),
    sessionId: app.sessionId,
    model: app.meta.model,
    permissionMode: options.appOptions.config.permissionMode,
    cwd: options.cwd,
    version: VERSION,
    resumed: resume !== undefined && resume !== null,
  };
}

function display(event: GaharEvent, renderer: Renderer): void {
  switch (event.type) {
    case "text_delta":
      renderer.text(event.text);
      break;
    case "reasoning_delta":
      renderer.reasoning(event.text);
      break;
    case "tool_use":
      renderer.toolUse(event.name, event.args);
      break;
    case "tool_result": {
      const total = event.output === "" ? 0 : event.output.split("\n").length;
      renderer.toolResult(event.name, event.ok, event.output, { totalLines: total });
      break;
    }
    case "notice":
      renderer.notice(event.level, event.message);
      break;
    case "error":
      renderer.error(event.message);
      break;
    case "compaction":
      renderer.info(`compacted ${event.messagesBefore} -> ${event.messagesAfter} messages`);
      break;
    default:
      break;
  }
}

export function failureExitCode(error: unknown): number {
  if (isAbortError(error)) return EXIT_INTERRUPT;
  if (error instanceof GaharError) return error.exitCode;
  const message = toErrorMessage(error);
  if (/(api key|unauthorized|not authenticated|401)/i.test(message)) return EXIT_AUTH_ERROR;
  return 1;
}
