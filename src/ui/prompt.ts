import { createInterface, type Interface } from "node:readline";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Writable } from "../cli/env.js";

export const MAX_HISTORY = 200;

export interface PromptOptions {
  configDir: string;
  stderr: Writable;
  /** When true an interactive readline prompt is used; otherwise a single read. */
  interactive: boolean;
  promptLabel?: string;
  /** Signals that the user pressed Ctrl+C while a turn was running. */
  onInterrupt?: () => void;
}

export type PromptResult =
  | { kind: "line"; text: string }
  | { kind: "eof" }
  | { kind: "interrupt" };

export interface LineEditor {
  read(): Promise<PromptResult>;
  close(): void;
  /** True while a turn is running: Ctrl+C aborts the turn instead of exiting. */
  setBusy(busy: boolean): void;
  /** Ctrl+C pressed twice at an empty prompt: exit with 130. */
  readonly interruptedTwice: boolean;
  readonly history: string[];
}

export function historyPath(configDir: string): string {
  return join(configDir, "history.txt");
}

export async function loadHistory(configDir: string, limit = MAX_HISTORY): Promise<string[]> {
  try {
    const raw = await readFile(historyPath(configDir), "utf8");
    const entries = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
    return entries.slice(-limit).reverse();
  } catch {
    return [];
  }
}

export async function saveHistory(configDir: string, history: readonly string[]): Promise<void> {
  const file = historyPath(configDir);
  try {
    await mkdir(dirname(file), { recursive: true });
    const lines = history.slice(0, MAX_HISTORY).reverse().join("\n");
    await writeFile(file, lines === "" ? "" : `${lines}\n`, "utf8");
  } catch {
    // History is a convenience; never fail the session for it.
  }
}

export async function appendHistory(configDir: string, entry: string): Promise<void> {
  const text = entry.trim();
  if (text === "") return;
  try {
    await mkdir(configDir, { recursive: true });
    await appendFile(historyPath(configDir), `${text.replace(/\r?\n/g, " ")}\n`, "utf8");
  } catch {
    // Ignore: history persistence is best effort.
  }
}

export function createLineEditor(options: PromptOptions): LineEditor {
  return new ReadlineEditor(options);
}

class ReadlineEditor implements LineEditor {
  private readonly options: PromptOptions;
  private rl: Interface | null = null;
  private busy = false;
  private lastInterruptAt = 0;
  private closed = false;
  historyEntries: string[] = [];
  private resolvePending: ((result: PromptResult) => void) | null = null;

  constructor(options: PromptOptions) {
    this.options = options;
  }

  get history(): string[] {
    return this.historyEntries;
  }

  get interruptedTwice(): boolean {
    return this.lastInterruptAt > 0;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    if (!busy) this.lastInterruptAt = 0;
  }

  async read(): Promise<PromptResult> {
    if (!this.options.interactive) return this.readOnce();
    const rl = this.ensureInterface();
    return new Promise<PromptResult>((resolve) => {
      this.resolvePending = resolve;
      rl.question(this.options.promptLabel ?? "> ", (answer) => {
        this.resolvePending = null;
        if (answer.trim() !== "") {
          this.historyEntries = [answer, ...this.historyEntries.filter((h) => h !== answer)];
          if (this.historyEntries.length > MAX_HISTORY) this.historyEntries.length = MAX_HISTORY;
          void appendHistory(this.options.configDir, answer);
        }
        resolve({ kind: "line", text: answer });
      });
      rl.once("close", () => {
        if (this.resolvePending !== null) {
          this.resolvePending = null;
          resolve({ kind: "eof" });
        }
      });
    });
  }

  private ensureInterface(): Interface {
    if (this.rl !== null) return this.rl;
    const rl = createInterface({ input: process.stdin, output: this.options.stderr, terminal: true });
    rl.on("SIGINT", () => {
      const now = Date.now();
      if (this.busy) {
        this.options.onInterrupt?.();
        this.lastInterruptAt = 0;
        return;
      }
      if (now - this.lastInterruptAt < 2000) {
        this.lastInterruptAt = now;
        this.finish({ kind: "interrupt" });
        return;
      }
      this.lastInterruptAt = now;
      this.options.stderr.write("\n(^C again to exit)\n");
      if (this.resolvePending !== null) {
        const resolve = this.resolvePending;
        this.resolvePending = null;
        resolve({ kind: "line", text: "" });
      }
    });
    rl.on("close", () => {
      this.closed = true;
    });
    this.rl = rl;
    return rl;
  }

  private finish(result: PromptResult): void {
    if (this.resolvePending !== null) {
      const resolve = this.resolvePending;
      this.resolvePending = null;
      resolve(result);
    }
  }

  private async readOnce(): Promise<PromptResult> {
    const chunks: Buffer[] = [];
    const input = process.stdin;
    return new Promise<PromptResult>((resolve) => {
      const onData = (chunk: Buffer): void => {
        chunks.push(chunk);
        const text = Buffer.concat(chunks).toString("utf8");
        const newline = text.indexOf("\n");
        if (newline >= 0) {
          cleanup();
          resolve({ kind: "line", text: text.slice(0, newline).replace(/\r$/, "") });
        }
      };
      const onEnd = (): void => {
        cleanup();
        const text = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
        resolve(text === "" ? { kind: "eof" } : { kind: "line", text });
      };
      const cleanup = (): void => {
        input.off("data", onData);
        input.off("end", onEnd);
        input.off("error", onEnd);
      };
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("error", onEnd);
      if (typeof input.resume === "function") input.resume();
    });
  }

  close(): void {
    if (this.rl !== null && !this.closed) {
      this.rl.close();
      this.rl = null;
    }
  }
}

/** Splits a pasted multi-line block into a single prompt string. */
export function normalizePastedInput(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}
