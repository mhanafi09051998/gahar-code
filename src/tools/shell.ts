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
/** PowerShell -Command reports only 0/1; forward the real native exit code instead. */
const PWSH_EPILOGUE =
  "\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }; exit $LASTEXITCODE";

/** Choose the shell: pwsh (else Windows PowerShell) on Windows, bash (else sh) on POSIX. */
export function resolveShell(command: string, platform = process.platform): ShellSpec {
  if (platform === "win32") {
    return {
      file: windowsShell(),
      args: ["-NoProfile", "-NonInteractive", "-Command", PWSH_PRELUDE + command + PWSH_EPILOGUE],
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
