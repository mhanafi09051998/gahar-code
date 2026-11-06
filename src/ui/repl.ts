import type { App, AppOptions } from "../contracts/runner.js";
import type { GaharEvent } from "../contracts/events.js";
import { GaharError, isAbortError, toErrorMessage } from "../shared/errors.js";
import { createBanner } from "../ui/banner.js";
import { createLineEditor, type LineEditor } from "../ui/prompt.js";
import { Renderer } from "../ui/render.js";
import { findCommand, helpLines, parseSlashInput } from "./commands.js";
import { EXIT_AUTH_ERROR, EXIT_INTERRUPT } from "./args.js";
import type { Writable } from "./env.js";

export interface ReplOptions {
  cwd: string;
  configDir: string;
  stdout: Writable;
  stderr: Writable;
  color: boolean;
  columns: number;
  quiet?: boolean;
  interactive?: boolean;
  createApp: (options: AppOptions) => Promise<App>;
  appOptions: Omit<AppOptions, "cwd" | "events">;
  editor?: LineEditor;
  installSignals?: (controller: AbortController) => () => void;
}

export interface ReplOutcome {
  exitCode: number;
  turns: number;
}

export async function runRepl(options: ReplOptions): Promise<ReplOutcome> {
  const renderer = new Renderer({
    stderr: options.stderr,
    stdout: options.stdout,
    color: options.color,
    json: false,
    columns: options.columns,
    quiet: options.quiet ?? false,
  });
  const editor =
    options.editor ??
    createLineEditor({
      configDir: options.configDir,
      stderr: options.stderr,
      interactive: options.interactive ?? true,
    });
  const events: GaharEvent[] = [];
  let app: App | null = null;
  let exitCode = 0;
  let turns = 0;
  let verbose = false;
  let exiting = false;
  const controller = { current: new AbortController() };
  const disposeSignals = options.installSignals?.(controller.current);

  try {
    app = await options.createApp({
      cwd: options.cwd,
      ...options.appOptions,
      events: (event) => {
        events.push(event);
        handleEvent(event, renderer, verbose);
      },
    });
    if (!(options.quiet ?? false)) {
      renderer.line(
        createBanner({
          stderr: options.stderr,
          model: app.meta.model,
          cwd: options.cwd,
          permissionMode: options.appOptions.config.permissionMode,
          sessionId: app.sessionId,
          resumed: options.appOptions.resume !== undefined,
          quiet: options.quiet,
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
      if (line.startsWith("/")) {
        const parsed = parseSlashInput(line);
        if (parsed !== null) {
          const command = findCommand(parsed.name);
          if (command === undefined) {
            renderer.warn(`unknown command ${parsed.name}`);
            renderer.line(helpLines().join("\n"));
            continue;
          }
          await command.run({
            app,
            cwd: options.cwd,
            configDir: options.configDir,
            args: parsed.args,
            verbose,
            setVerbose: (value) => {
              verbose = value;
            },
            setModel: () => undefined,
            clearScreen: () => renderer.line("\u001b[2J\u001b[H"),
            requestExit: () => {
              exiting = true;
            },
            print: (text) => renderer.line(text),
          });
          continue;
        }
      }
      editor.setBusy(true);
      controller.current = new AbortController();
      try {
        renderer.spinnerStart("thinking");
        await app.runTurn(line, controller.current.signal);
        turns += 1;
      } catch (error) {
        if (isAbortError(error)) {
          renderer.warn("turn cancelled");
          exitCode = 0;
        } else {
          renderer.error(toErrorMessage(error));
          if (error instanceof GaharError && error.exitCode === EXIT_AUTH_ERROR) {
            renderer.line("  Run: gahar auth login");
          }
        }
      } finally {
        renderer.spinnerStop();
        editor.setBusy(false);
      }
    }
  } catch (error) {
    renderer.error(toErrorMessage(error));
    exitCode = exitCode === 0 ? 1 : exitCode;
  } finally {
    disposeSignals?.();
    editor.close();
    if (app !== null) {
      try {
        await app.close();
      } catch {
        // ignore close failures
      }
    }
  }
  return { exitCode, turns };
}

function handleEvent(event: GaharEvent, renderer: Renderer, verbose: boolean): void {
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
      renderer.warn(`auto-compacted history: ${event.messagesBefore} -> ${event.messagesAfter} messages`);
      break;
    case "error":
      renderer.error(event.message);
      break;
    case "update_available":
      renderer.info(`update available: ${event.latestVersion} (${event.releaseUrl})`);
      break;
    default:
      break;
  }
}
