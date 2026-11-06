import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";

export const MAX_HISTORY = 200;
/** Lines arriving within this window after the first one are treated as one paste. */
const PASTE_WINDOW_MS = 25;
const DOUBLE_INTERRUPT_MS = 2000;

export interface PromptOptions {
  configDir: string;
  /** When true an interactive readline prompt is used; otherwise stdin is read once. */
  interactive: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  promptLabel?: string;
  /** Called when the user presses Ctrl+C while a turn is running. */
  onInterrupt?: () => void;
}

export type PromptResult = { kind: "line"; text: string } | { kind: "eof" } | { kind: "interrupt" };

export interface LineEditor {
  read(): Promise<PromptResult>;
  /** Asks a one-line question (used by approval prompts while a turn runs). */
  ask(question: string): Promise<string>;
  close(): void;
  /** True while a turn is running: Ctrl+C aborts the turn instead of exiting. */
  setBusy(busy: boolean): void;
  readonly history: string[];
}

export function historyPath(configDir: string): string {
  return join(configDir, "history.txt");
}

/** Loads history newest first (the order readline expects). */
export async function loadHistory(configDir: string, limit = MAX_HISTORY): Promise<string[]> {
  try {
    const raw = await readFile(historyPath(configDir), "utf8");
    const entries = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
    return entries.slice(-limit).reverse();
  } catch {
    return [];
  }
}

/** Persists newest-first history as an oldest-first file capped at MAX_HISTORY lines. */
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

/** Adds an entry to newest-first history, de-duplicating and capping the size. */
export function pushHistory(history: readonly string[], entry: string): string[] {
  const text = entry.replace(/\r?\n/g, " ").trim();
  if (text === "") return [...history];
  return [text, ...history.filter((item) => item !== text)].slice(0, MAX_HISTORY);
}

export function createLineEditor(options: PromptOptions): LineEditor {
  return options.interactive ? new ReadlineEditor(options) : new OnceEditor(options);
}

/** Non-TTY editor: the whole of stdin is one prompt, then EOF. */
class OnceEditor implements LineEditor {
  private consumed = false;
  readonly history: string[] = [];

  constructor(private readonly options: PromptOptions) {}

  async read(): Promise<PromptResult> {
    if (this.consumed) return { kind: "eof" };
    this.consumed = true;
    const text = (await readAll(this.options.input ?? process.stdin)).replace(/\r?\n$/, "");
    return text.trim() === "" ? { kind: "eof" } : { kind: "line", text };
  }

  async ask(): Promise<string> {
    return "";
  }

  setBusy(): void {}

  close(): void {}
}

class ReadlineEditor implements LineEditor {
  private rl: Interface | null = null;
  private busy = false;
  private closed = false;
  private lastInterruptAt = 0;
  private entries: string[] = [];
  private pending: ((result: PromptResult) => void) | null = null;
  private askPending: ((answer: string) => void) | null = null;
  private pasteLines: string[] = [];
  private pasteTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: PromptOptions) {}

  get history(): string[] {
    return this.entries;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    if (!busy) this.lastInterruptAt = 0;
  }

  async read(): Promise<PromptResult> {
    const rl = await this.ensureInterface();
    if (this.closed) return { kind: "eof" };
    return new Promise<PromptResult>((resolve) => {
      this.pending = resolve;
      rl.setPrompt(this.options.promptLabel ?? "> ");
      rl.prompt();
    });
  }

  async ask(question: string): Promise<string> {
    const rl = await this.ensureInterface();
    if (this.closed) return "";
    return new Promise<string>((resolve) => {
      this.askPending = resolve;
      rl.setPrompt(question);
      rl.prompt();
    });
  }

  close(): void {
    if (this.rl !== null && !this.closed) this.rl.close();
    this.rl = null;
  }

  private async ensureInterface(): Promise<Interface> {
    if (this.rl !== null) return this.rl;
    this.entries = await loadHistory(this.options.configDir);
    const rl = createInterface({
      input: this.options.input ?? process.stdin,
      output: this.options.output ?? process.stderr,
      terminal: true,
      history: [...this.entries],
      historySize: MAX_HISTORY,
    });
    rl.on("line", (line) => this.onLine(line));
    rl.on("SIGINT", () => this.onSigint());
    rl.on("close", () => {
      this.closed = true;
      this.resolveAsk("");
      this.settle({ kind: "eof" });
    });
    this.rl = rl;
    return rl;
  }

  private onLine(line: string): void {
    if (this.askPending !== null) {
      this.resolveAsk(line);
      return;
    }
    if (this.pending === null) return;
    this.pasteLines.push(line);
    if (this.pasteTimer !== null) clearTimeout(this.pasteTimer);
    this.pasteTimer = setTimeout(() => this.flushPaste(), PASTE_WINDOW_MS);
  }

  private flushPaste(): void {
    this.pasteTimer = null;
    const text = this.pasteLines.join("\n");
    this.pasteLines = [];
    if (text.trim() !== "") {
      this.entries = pushHistory(this.entries, text);
      void saveHistory(this.options.configDir, this.entries);
    }
    this.settle({ kind: "line", text });
  }

  private onSigint(): void {
    if (this.busy) {
      this.resolveAsk("");
      this.options.onInterrupt?.();
      return;
    }
    const now = Date.now();
    if (now - this.lastInterruptAt < DOUBLE_INTERRUPT_MS) {
      this.settle({ kind: "interrupt" });
      return;
    }
    this.lastInterruptAt = now;
    (this.options.output ?? process.stderr).write("\n(^C again to exit)\n");
    this.settle({ kind: "line", text: "" });
  }

  private settle(result: PromptResult): void {
    const resolve = this.pending;
    this.pending = null;
    resolve?.(result);
  }

  private resolveAsk(answer: string): void {
    const resolve = this.askPending;
    this.askPending = null;
    resolve?.(answer);
  }
}

async function readAll(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of input) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
  } catch {
    // A broken pipe ends the read with whatever arrived.
  }
  return Buffer.concat(chunks).toString("utf8");
}
