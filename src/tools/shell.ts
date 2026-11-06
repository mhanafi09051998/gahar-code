import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface ShellSpec {
  file: string;
  args: string[];
}

/** Environment variables never passed to model-driven commands. */
const SECRET_ENV = /^OPENROUTER_API_KEY$/i;

/** Finds an executable on PATH (honouring PATHEXT on Windows). */
export function findOnPath(
  name: string,
  env = process.env,
  platform = process.platform,
): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter);
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    if (dir.length === 0) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase());
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

let cachedWindowsShell: string | undefined;

function windowsShell(): string {
  if (process.env.GAHAR_SHELL === "powershell") return "powershell.exe";
  cachedWindowsShell ??= findOnPath("pwsh") === null ? "powershell.exe" : "pwsh";
  return cachedWindowsShell;
}

const PWSH_PRELUDE =
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; $global:LASTEXITCODE=0\n";

/** PowerShell treats typographic quotes as quote characters too. */
function psSingleQuoted(text: string): string {
  return `'${text.replace(/['\u2018-\u201b]/g, "$&$&")}'`;
}

/**
 * Exit code with bash semantics: the status of the last statement. If that
 * statement ends in a native program, use its exit code (Windows PowerShell 5.1
 * sets $? to false for any stderr output under 2>&1); otherwise use $?, so a
 * stale $LASTEXITCODE from an earlier native command never leaks through.
 */
function pwshEpilogue(command: string): string {
  return [
    "",
    "$__gaharOk = $?; $__gaharCode = $LASTEXITCODE; $__gaharNative = $false",
    `$__gaharAst = [System.Management.Automation.Language.Parser]::ParseInput(${psSingleQuoted(command)}, [ref]$null, [ref]$null)`,
    "$__gaharLast = @($__gaharAst.EndBlock.Statements)[-1]",
    "$__gaharCmd = if ($__gaharLast -is [System.Management.Automation.Language.PipelineAst]) { $__gaharLast.PipelineElements[-1] }",
    "if ($__gaharCmd -is [System.Management.Automation.Language.CommandAst] -and $__gaharCmd.GetCommandName()) {",
    "  $__gaharNative = @(Get-Command $__gaharCmd.GetCommandName() -ErrorAction SilentlyContinue)[0].CommandType -eq 'Application'",
    "}",
    "if ($__gaharNative) { exit [int]$__gaharCode } elseif ($__gaharOk) { exit 0 } else { exit 1 }",
  ].join("\n");
}

/** Choose the shell: pwsh (else Windows PowerShell) on Windows, bash (else sh) on POSIX. */
export function resolveShell(command: string, platform = process.platform): ShellSpec {
  if (platform === "win32") {
    return {
      file: windowsShell(),
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        PWSH_PRELUDE + command + pwshEpilogue(command),
      ],
    };
  }
  if (existsSync("/bin/bash")) return { file: "/bin/bash", args: ["-lc", command] };
  return { file: "/bin/sh", args: ["-c", command] };
}

/** Child environment without the configured API key variables. */
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!SECRET_ENV.test(key)) out[key] = value;
  }
  return out;
}

/** Kills the whole process tree: taskkill /T on Windows, the process group on POSIX. */
export function killTree(pid: number, platform = process.platform): void {
  if (platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      .on("error", () => undefined)
      .unref();
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

/**
 * Keeps the head and tail of a stream within a fixed budget so a chatty
 * command cannot exhaust memory; the middle is counted, not stored.
 */
export class OutputCollector {
  private head = "";
  private tail = "";
  private omitted = 0;
  private readonly half: number;

  constructor(maxChars: number) {
    this.half = Math.max(1, Math.floor(maxChars / 2));
  }

  push(chunk: string): void {
    if (this.head.length < this.half) {
      const room = this.half - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (chunk.length === 0) return;
    this.tail += chunk;
    if (this.tail.length > this.half) {
      this.omitted += this.tail.length - this.half;
      this.tail = this.tail.slice(-this.half);
    }
  }

  text(): string {
    if (this.omitted === 0) return this.head + this.tail;
    return `${this.head}\n... [output truncated, ${this.omitted} characters omitted] ...\n${this.tail}`;
  }
}
