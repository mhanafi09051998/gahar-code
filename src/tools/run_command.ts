import { spawn } from "node:child_process";

import type { JsonSchema } from "../contracts/messages.js";
import type { Tool, ToolContext, ToolResult } from "../contracts/tools.js";
import { truncateMiddle } from "../shared/truncate.js";
import { asRecord, clampInteger, invalidArguments, optionalNumber, optionalString, requireString } from "./args.js";
import { numberProperty, objectSchema, stringProperty } from "./schema.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;

export interface ShellSpec {
  file: string;
  args: string[];
}

/** Choose the shell for this platform; pwsh is preferred when it is installed. */
export function resolveShell(command: string, platform = process.platform): ShellSpec {
  if (platform === "win32") {
    const usesPwsh = process.env.GAHAR_SHELL !== "powershell";
    const file = usesPwsh ? "pwsh" : "powershell.exe";
    const prelude = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; ";
    return { file, args: ["-NoProfile", "-NonInteractive", "-Command", prelude + command] };
  }
  return { file: "/bin/bash", args: ["-lc", command] };
}

export function killTree(pid: number, platform = process.platform): void {
  if (platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }).unref();
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

export class RunCommandTool implements Tool {
  readonly name = "run_command";
  readonly description = "Run a shell command in the workspace and return its combined output and exit code. PowerShell on Windows, bash on POSIX.";
  readonly readOnly = false;
  readonly parameters: JsonSchema = objectSchema(
    {
      command: stringProperty("Command line to execute."),
      cwd: stringProperty("Working directory, relative to the workspace. Defaults to the workspace root."),
      timeout_ms: numberProperty(`Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`),
    },
    ["command"],
  );

  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const args = asRecord(rawArgs, this.name);
      const command = requireString(args, "command");
      const timeoutMs = clampInteger(
        optionalNumber(args, "timeout_ms"),
        1_000,
        MAX_TIMEOUT_MS,
        DEFAULT_TIMEOUT_MS,
      );
      const inputCwd = optionalString(args, "cwd");
      let cwd = ctx.cwd;
      if (inputCwd !== undefined) {
        const resolved = await ctx.paths.resolveForRead(inputCwd, ctx.signal);
        if (!resolved.inside) {
          return { ok: false, output: `run_command: refusing to run outside the workspace: ${inputCwd}` };
        }
        cwd = resolved.abs;
      }
      return await this.run(command, cwd, timeoutMs, ctx);
    } catch (error) {
      return invalidArguments(this.name, error);
    }
  }

  private run(command: string, cwd: string, timeoutMs: number, ctx: ToolContext): Promise<ToolResult> {
    const shell = resolveShell(command);
    return new Promise<ToolResult>((resolvePromise) => {
      const child = spawn(shell.file, shell.args, { cwd, windowsHide: true, detached: process.platform !== "win32" });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: ToolResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        resolvePromise(result);
      };
      const onAbort = (): void => {
        if (child.pid !== undefined) killTree(child.pid);
        finish({ ok: false, output: `run_command: cancelled by the user: ${command}` });
      };
      const timer = setTimeout(() => {
        if (child.pid !== undefined) killTree(child.pid);
        finish({
          ok: false,
          output: `run_command: timed out after ${timeoutMs} ms: ${command}\n${truncateMiddle(
            stdout + stderr,
            MAX_OUTPUT_CHARS,
            "output",
          ).text}`,
        });
      }, timeoutMs);
      if (ctx.signal.aborted) {
        onAbort();
        return;
      }
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error: Error) => {
        finish({ ok: false, output: `run_command: could not start ${shell.file}: ${error.message}` });
      });
      child.on("close", (code: number | null) => {
        const combined = [stdout, stderr].filter((part) => part.length > 0).join("\n");
        const body = truncateMiddle(combined, MAX_OUTPUT_CHARS, "output").text;
        const exitCode = code ?? -1;
        finish({
          ok: exitCode === 0,
          output: `exit code: ${exitCode}\n${body.length > 0 ? body : "(no output)"}`,
          summary: `exit ${exitCode}`,
        });
      });
    });
  }
}

export const runCommandTool = new RunCommandTool();
