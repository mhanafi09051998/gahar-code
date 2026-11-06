import { spawn } from "node:child_process";

import type { JsonSchema } from "../contracts/messages.js";
import type { Tool, ToolContext, ToolResult } from "../contracts/tools.js";
import { redactSecrets } from "../security/redact.js";
import { requirePermission } from "./access.js";
import {
  asRecord,
  clampInteger,
  invalidArguments,
  optionalNumber,
  optionalString,
  requireString,
} from "./args.js";
import { numberProperty, objectSchema, stringProperty } from "./schema.js";
import { commandEnv, killTree, OutputCollector, resolveShell } from "./shell.js";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
export const MAX_OUTPUT_CHARS = 30_000;

export class RunCommandTool implements Tool {
  readonly name = "run_command";
  readonly description =
    "Run a shell command in the workspace and return its combined output and exit code. PowerShell on Windows, bash on POSIX.";
  readonly readOnly = false;
  readonly parameters: JsonSchema = objectSchema(
    {
      command: stringProperty("Command line to execute."),
      cwd: stringProperty(
        "Working directory, relative to the workspace. Defaults to the workspace root.",
      ),
      timeout_ms: numberProperty(
        `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
      ),
    },
    ["command"],
  );

  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const args = asRecord(rawArgs, this.name);
      const command = requireString(args, "command");
      const timeoutMs = clampInteger(
        optionalNumber(args, "timeout_ms"),
        100,
        MAX_TIMEOUT_MS,
        DEFAULT_TIMEOUT_MS,
      );
      const inputCwd = optionalString(args, "cwd");
      let cwd = ctx.cwd;
      if (inputCwd !== undefined) {
        const resolved = await ctx.paths.resolveForRead(inputCwd, ctx.signal);
        if (!resolved.inside) {
          return {
            ok: false,
            output: `run_command: refusing to run outside the workspace: ${inputCwd}`,
          };
        }
        if (resolved.type !== "directory") {
          return { ok: false, output: `run_command: cwd is not a directory: ${inputCwd}` };
        }
        cwd = resolved.abs;
      }
      const denied = await requirePermission(ctx, {
        tool: this.name,
        action: "shell",
        title: `Run: ${command}`,
        resource: command,
        detail: `cwd: ${ctx.paths.relative(cwd)}`,
      });
      if (denied !== null) return denied;
      const result = await this.run(command, cwd, timeoutMs, ctx.signal);
      const secrets = ctx.config.apiKey === null ? [] : [ctx.config.apiKey];
      return { ...result, output: redactSecrets(result.output, secrets) };
    } catch (error) {
      return invalidArguments(this.name, error);
    }
  }

  private run(
    command: string,
    cwd: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const shell = resolveShell(command);
    const output = new OutputCollector(MAX_OUTPUT_CHARS);
    return new Promise<ToolResult>((resolvePromise) => {
      if (signal.aborted) {
        resolvePromise({ ok: false, output: `run_command: cancelled before start: ${command}` });
        return;
      }
      const child = spawn(shell.file, shell.args, {
        cwd,
        env: commandEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      let settled = false;
      const finish = (result: ToolResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolvePromise(result);
      };
      const stop = (reason: string): void => {
        if (child.pid !== undefined) killTree(child.pid);
        finish({ ok: false, output: `run_command: ${reason}: ${command}\n${output.text()}` });
      };
      const onAbort = (): void => stop("cancelled by the user");
      const timer = setTimeout(() => stop(`timed out after ${timeoutMs} ms`), timeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => output.push(chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => output.push(chunk));
      child.on("error", (error: Error) => {
        finish({
          ok: false,
          output: `run_command: could not start ${shell.file}: ${error.message}`,
        });
      });
      child.on("close", (code: number | null, killedBy: NodeJS.Signals | null) => {
        const exitCode = code ?? -1;
        const body = output.text();
        const suffix = killedBy === null ? "" : ` (signal ${killedBy})`;
        finish({
          ok: exitCode === 0,
          output: `exit code: ${exitCode}${suffix}\n${body.length > 0 ? body : "(no output)"}`,
          summary: `exit ${exitCode}`,
        });
      });
    });
  }
}

export const runCommandTool = new RunCommandTool();
