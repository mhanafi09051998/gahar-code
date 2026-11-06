import type { GaharEvent } from "../contracts/events.js";
import type { App, AppOptions, TurnResult } from "../contracts/runner.js";
import { GaharError, isAbortError, toErrorMessage } from "../shared/errors.js";
import { VERSION } from "../shared/version.js";
import { Renderer } from "../ui/render.js";
import { handleEvent } from "../ui/repl.js";
import { EXIT_AUTH_ERROR, EXIT_INTERRUPT } from "./args.js";
import type { Writable } from "./env.js";
import { JsonEventWriter } from "./json-output.js";

export interface HeadlessOptions {
  prompt: string;
  cwd: string;
  json: boolean;
  columns?: number;
  color: boolean;
  stdout: Writable;
  stderr: Writable;
  createApp: (options: AppOptions) => Promise<App>;
  appOptions: Omit<AppOptions, "cwd" | "events">;
  /** Wires process signals to abort the turn; returns a disposer. */
  installSignals?: (abort: () => void) => () => void;
}

export interface HeadlessOutcome {
  exitCode: number;
  text: string;
  result: TurnResult | null;
}

/**
 * Runs one prompt and exits. Plain mode streams the answer to stdout and
 * everything else to stderr; JSON mode writes only JSONL events to stdout.
 */
export async function runHeadless(options: HeadlessOptions): Promise<HeadlessOutcome> {
  const writer = new JsonEventWriter({ stdout: options.stdout, enabled: options.json });
  const renderer = new Renderer({
    stderr: options.stderr,
    color: options.color && !options.json,
    json: options.json,
    columns: options.columns,
    quiet: true,
  });
  const controller = new AbortController();
  const disposeSignals = options.installSignals?.(() => controller.abort());
  let streamed = "";
  let app: App | null = null;
  try {
    app = await options.createApp({
      cwd: options.cwd,
      ...options.appOptions,
      events: (event) => {
        writer.emit(event);
        if (options.json) return;
        if (event.type === "text_delta") {
          streamed += event.text;
          options.stdout.write(event.text);
        } else {
          handleEvent(event, renderer, false);
        }
      },
    });
    writer.emit(initEvent(app, options));
    const result = await app.runTurn(options.prompt, controller.signal);
    writer.emit(resultEvent(app.sessionId, result));
    if (!options.json) {
      if (streamed === "") options.stdout.write(result.text);
      const printed = streamed === "" ? result.text : streamed;
      if (printed !== "" && !printed.endsWith("\n")) options.stdout.write("\n");
      renderer.usageLine({
        total: result.usage.total_tokens,
        cost: typeof result.usage.cost === "number" ? result.usage.cost : undefined,
        elapsedMs: result.durationMs,
      });
    }
    return { exitCode: 0, text: result.text, result };
  } catch (error) {
    const exitCode = controller.signal.aborted ? EXIT_INTERRUPT : failureExitCode(error);
    const message = exitCode === EXIT_INTERRUPT ? "interrupted" : toErrorMessage(error);
    const code = error instanceof GaharError ? error.code : undefined;
    if (options.json) writer.emitError(message, code);
    else renderer.error(message);
    return { exitCode, text: "", result: null };
  } finally {
    disposeSignals?.();
    // Closing a broken session must not mask the original failure.
    await app?.close().catch(() => undefined);
  }
}

function initEvent(app: App, options: HeadlessOptions): GaharEvent {
  return {
    type: "init",
    at: new Date().toISOString(),
    sessionId: app.sessionId,
    model: app.meta.model,
    permissionMode: options.appOptions.config.permissionMode,
    cwd: options.cwd,
    version: VERSION,
    resumed: options.appOptions.resume !== undefined,
  };
}

function resultEvent(sessionId: string, result: TurnResult): GaharEvent {
  return {
    type: "result",
    at: new Date().toISOString(),
    text: result.text,
    sessionId,
    durationMs: result.durationMs,
    usage: result.usage,
    costUsd: typeof result.usage.cost === "number" ? result.usage.cost : 0,
    finishReason: result.finishReason,
    isError: false,
  };
}

export function failureExitCode(error: unknown): number {
  if (isAbortError(error)) return EXIT_INTERRUPT;
  if (error instanceof GaharError) return error.exitCode;
  if (error instanceof Error && error.name === "MissingApiKeyError") return EXIT_AUTH_ERROR;
  if (/(api key|unauthorized|not authenticated|401)/i.test(toErrorMessage(error))) {
    return EXIT_AUTH_ERROR;
  }
  return 1;
}
