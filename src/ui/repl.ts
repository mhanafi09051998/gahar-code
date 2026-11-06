import { EXIT_AUTH_ERROR, EXIT_INTERRUPT } from "../cli/args.js";
import { dispatchSlash } from "../cli/commands.js";
import type { Writable } from "../cli/env.js";
import type { GaharEvent } from "../contracts/events.js";
import type { App, AppOptions } from "../contracts/runner.js";
import { GaharError, isAbortError, toErrorMessage } from "../shared/errors.js";
import { createApprovalHandler } from "./approval.js";
import { createBanner } from "./banner.js";
import { createLineEditor, type LineEditor } from "./prompt.js";
import { Renderer } from "./render.js";

export interface ReplOptions {
  cwd: string;
  configDir: string;
  stderr: Writable;
  color: boolean;
  columns: number;
  quiet?: boolean;
  /** Whether OPENROUTER_API_KEY is set (shown by /auth). */
  envKey?: boolean;
  createApp: (options: AppOptions) => Promise<App>;
  appOptions: Omit<AppOptions, "cwd" | "events" | "approvals">;
  /** Injectable for tests; defaults to a readline editor on stdin. */
  editor?: LineEditor;
  /** Wires process signals to abort the running turn; returns a disposer. */
  installSignals?: (abort: () => void) => () => void;
}

export interface ReplOutcome {
  exitCode: number;
  turns: number;
}

export async function runRepl(options: ReplOptions): Promise<ReplOutcome> {
  const renderer = new Renderer({
    stderr: options.stderr,
    color: options.color,
    json: false,
    columns: options.columns,
    quiet: options.quiet ?? false,
  });
  let turn = new AbortController();
  const abortTurn = (): void => turn.abort();
  const editor =
    options.editor ??
    createLineEditor({ configDir: options.configDir, interactive: true, onInterrupt: abortTurn });
  const approvals = createApprovalHandler({
    stderr: options.stderr,
    interactive: true,
    ask: (question) => editor.ask(question),
    beforePrompt: () => renderer.spinnerStop(),
    renderDetail: (detail) => renderer.diff(detail),
  });
  let app: App | null = null;
  let exitCode = 0;
  let turns = 0;
  let verbose = false;
  let exiting = false;
  const disposeSignals = options.installSignals?.(abortTurn);

  try {
    app = await options.createApp({
      cwd: options.cwd,
      ...options.appOptions,
      approvals,
      events: (event) => handleEvent(event, renderer, verbose),
    });
    if (!(options.quiet ?? false)) {
      renderer.line(
        createBanner({
          model: app.meta.model,
          cwd: options.cwd,
          permissionMode: options.appOptions.config.permissionMode,
          sessionId: app.sessionId,
          resumed: options.appOptions.resume !== undefined,
          columns: options.columns,
        }).join("\n"),
      );
      renderer.line();
    }
    while (!exiting) {
      const result = await editor.read();
      if (result.kind === "eof") break;
      if (result.kind === "interrupt") {
        exitCode = EXIT_INTERRUPT;
        break;
      }
      const line = result.text.trim();
      if (line === "") continue;
      const current: App = app;
      const handled = await dispatchSlash(line, {
        app: current,
        cwd: options.cwd,
        envKey: options.envKey ?? false,
        verbose,
        setVerbose: (value) => {
          verbose = value;
        },
        clearScreen: () => options.stderr.write("\u001b[2J\u001b[H"),
        requestExit: () => {
          exiting = true;
        },
        print: (text) => renderer.line(text),
      });
      if (handled) continue;
      turn = new AbortController();
      if (await runOneTurn(current, line, turn.signal, editor, renderer)) turns += 1;
    }
  } catch (error) {
    renderer.error(toErrorMessage(error));
    exitCode = error instanceof GaharError ? error.exitCode : 1;
  } finally {
    disposeSignals?.();
    editor.close();
    await app?.close().catch(() => undefined);
  }
  return { exitCode, turns };
}

/** Runs one model turn; failures are rendered and never end the session. */
async function runOneTurn(
  app: App,
  input: string,
  signal: AbortSignal,
  editor: LineEditor,
  renderer: Renderer,
): Promise<boolean> {
  editor.setBusy(true);
  renderer.spinnerStart("thinking");
  try {
    const result = await app.runTurn(input, signal);
    renderer.line();
    renderer.usageLine({
      total: result.usage.total_tokens,
      cost: typeof result.usage.cost === "number" ? result.usage.cost : undefined,
      elapsedMs: result.durationMs,
    });
    return true;
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      renderer.warn("turn cancelled");
    } else {
      renderer.error(toErrorMessage(error));
      if (error instanceof GaharError && error.exitCode === EXIT_AUTH_ERROR) {
        renderer.line("  Run: gahar auth login");
      }
    }
    return false;
  } finally {
    renderer.spinnerStop();
    editor.setBusy(false);
  }
}

export function handleEvent(event: GaharEvent, renderer: Renderer, verbose: boolean): void {
  switch (event.type) {
    case "text_delta":
      renderer.text(event.text);
      break;
    case "reasoning_delta":
      if (verbose) renderer.reasoning(event.text);
      break;
    case "tool_use":
      renderer.toolUse(event.name, event.args);
      break;
    case "tool_result":
      renderer.toolResult(event.name, event.ok, event.output);
      break;
    case "notice":
      renderer.notice(event.level, event.message);
      break;
    case "compaction":
      renderer.warn(
        `auto-compacted history: ${event.messagesBefore} -> ${event.messagesAfter} messages`,
      );
      break;
    case "error":
      renderer.error(event.message);
      break;
    default:
      break;
  }
}
