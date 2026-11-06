import { createRequire } from "node:module";
import type { Writable } from "../cli/env.js";

const require = createRequire(import.meta.url);

interface Colorizer {
  bold: (text: string) => string;
  dim: (text: string) => string;
  red: (text: string) => string;
  green: (text: string) => string;
  yellow: (text: string) => string;
  cyan: (text: string) => string;
  magenta: (text: string) => string;
  gray: (text: string) => string;
  reset: (text: string) => string;
}

const identity = (text: string): string => text;
const PLAIN: Colorizer = {
  bold: identity,
  dim: identity,
  red: identity,
  green: identity,
  yellow: identity,
  cyan: identity,
  magenta: identity,
  gray: identity,
  reset: identity,
};

export interface RendererOptions {
  stderr: Writable;
  stdout?: Writable;
  color: boolean;
  json: boolean;
  columns?: number;
  stream?: boolean;
  quiet?: boolean;
}

export interface ToolResultSummaryOptions {
  firstLines?: number;
  totalLines?: number;
}

export class Renderer {
  private readonly out: Writable;
  private readonly colorizer: Colorizer;
  private readonly json: boolean;
  private readonly stream: boolean;
  private readonly quiet: boolean;
  private columns: number;
  private atLineStart = true;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private spinnerFrame = 0;
  private thinking = false;
  readonly stdout: Writable;

  constructor(options: RendererOptions) {
    this.out = options.stderr;
    this.stdout = options.stdout ?? options.stderr;
    this.colorizer = options.color ? loadColors() : PLAIN;
    this.json = options.json;
    this.stream = options.stream ?? true;
    this.quiet = options.quiet ?? false;
    this.columns = Math.max(20, options.columns ?? 80);
  }

  setColumns(columns: number): void {
    this.columns = Math.max(20, columns);
  }

  get isJson(): boolean {
    return this.json;
  }

  color(enabled: boolean): void {
    void enabled;
  }

  /** Writes a full line to stderr. */
  line(text = ""): void {
    if (!this.atLineStart) this.out.write("\n");
    this.out.write(`${text}\n`);
    this.atLineStart = true;
  }

  /** Writes a chunk without forcing a newline (streaming text). */
  chunk(text: string): void {
    if (text === "") return;
    this.stopSpinner();
    this.out.write(text);
    this.atLineStart = text.endsWith("\n");
  }

  /** Streaming assistant text with a subtle left gutter on the first chunk. */
  text(text: string): void {
    this.stopSpinner();
    if (this.atLineStart && text.trim() !== "") this.out.write(this.c("dim", "| "));
    this.out.write(text);
    this.atLineStart = text.endsWith("\n");
  }

  reasoning(text: string): void {
    if (this.quiet || text === "") return;
    this.stopSpinner();
    if (this.atLineStart) this.out.write(this.c("gray", "~ "));
    this.out.write(this.c("gray", text));
    this.atLineStart = text.endsWith("\n");
  }

  info(message: string): void {
    this.stopSpinner();
    this.line(`${this.c("cyan", "•")} ${message}`);
  }

  warn(message: string): void {
    this.stopSpinner();
    this.line(`${this.c("yellow", "!")} ${message}`);
  }

  error(message: string, hint?: string): void {
    this.stopSpinner();
    this.line(`${this.c("red", "error:")} ${message}`);
    if (hint !== undefined && hint !== "") this.line(`  ${this.c("dim", hint)}`);
  }

  notice(level: "info" | "warn" | "error", message: string): void {
    if (level === "error") this.error(message);
    else if (level === "warn") this.warn(message);
    else this.info(message);
  }

  toolUse(name: string, args: unknown): void {
    this.stopSpinner();
    this.line(`${this.c("magenta", "->")} ${name} ${this.c("dim", formatArgs(args))}`);
  }

  toolResult(name: string, ok: boolean, output: string, options: ToolResultSummaryOptions = {}): void {
    this.stopSpinner();
    const firstLines = options.firstLines ?? 3;
    const lines = output.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
    const total = options.totalLines ?? lines.length;
    const marker = ok ? this.c("green", "ok") : this.c("red", "fail");
    this.line(`${this.c("dim", "  <-")} ${name} ${marker}`);
    const shown = lines.slice(0, firstLines);
    for (const raw of shown) {
      this.line(`${this.c("dim", "  | ")}${truncateLine(raw, this.columns - 4)}`);
    }
    const hidden = total - shown.length;
    if (hidden > 0) this.line(`${this.c("dim", `  | ... ${hidden} more line${hidden === 1 ? "" : "s"}`)}`);
  }

  /** Renders a unified diff with +/- coloring, collapsing unchanged context. */
  diff(patch: string, maxLines = 200): void {
    const lines = patch.replace(/\r\n/g, "\n").split("\n");
    let printed = 0;
    for (const raw of lines) {
      if (raw === "") continue;
      if (printed >= maxLines) {
        this.line(this.c("dim", `  ... ${lines.length - printed} more diff lines`));
        break;
      }
      let rendered = raw;
      if (raw.startsWith("+") && !raw.startsWith("+++")) rendered = this.c("green", raw);
      else if (raw.startsWith("-") && !raw.startsWith("---")) rendered = this.c("red", raw);
      else if (raw.startsWith("@@")) rendered = this.c("cyan", raw);
      else rendered = this.c("dim", raw);
      this.line(truncateLine(rendered, this.columns));
      printed += 1;
    }
  }

  usageLine(usage: { total?: number; cost?: number; model?: string; elapsedMs?: number }): void {
    const parts: string[] = [];
    if (usage.model) parts.push(usage.model);
    if (usage.total !== undefined) parts.push(`${usage.total} tokens`);
    if (usage.cost !== undefined) parts.push(formatCost(usage.cost));
    if (usage.elapsedMs !== undefined) parts.push(`${(usage.elapsedMs / 1000).toFixed(1)}s`);
    if (parts.length === 0) return;
    this.line(this.c("dim", parts.join(" · ")));
  }

  spinnerStart(label = "thinking"): void {
    this.thinking = true;
    if (this.json || this.spinnerTimer !== null) return;
    const frames = ["|", "/", "-", "\\\\"];
    this.spinnerTimer = setInterval(() => {
      const frame = frames[this.spinnerFrame % frames.length] ?? "|";
      this.spinnerFrame += 1;
      this.out.write(`\r${this.c("dim", `${frame} ${label}...`)}`);
    }, 120);
    if (typeof this.spinnerTimer.unref === "function") this.spinnerTimer.unref();
  }

  spinnerStop(): void {
    this.stopSpinner(true);
  }

  private stopSpinner(clear = false): void {
    if (this.spinnerTimer !== null) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
      void clear;
      if (!this.atLineStart) this.out.write("\r\u001b[K");
      this.atLineStart = true;
      this.thinking = false;
      return;
    }
    if (this.thinking) {
      this.thinking = false;
      if (!this.atLineStart) {
        this.out.write("\r\u001b[K");
        this.atLineStart = true;
      }
    }
  }

  private c(kind: keyof Colorizer, text: string): string {
    if (this.stream === false) return text;
    return this.colorizer[kind](text);
  }
}

export function loadColors(): Colorizer {
  try {
    const mod = require("picocolors") as Partial<Colorizer> & { default?: Partial<Colorizer> };
    const candidate = (mod.default ?? mod) as Partial<Colorizer>;
    if (typeof candidate.red === "function" && typeof candidate.dim === "function") {
      return candidate as Colorizer;
    }
  } catch {
    // picocolors is optional at runtime; plain output is always available.
  }
  return PLAIN;
}

export function plainColors(): Colorizer {
  return PLAIN;
}

export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.0000";
  if (cost < 0.0001) return `<$0.0001`;
  return `$${cost.toFixed(4)}`;
}

export function formatArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return args;
  try {
    const json = JSON.stringify(args);
    if (json === undefined) return "";
    return json.length > 120 ? `${json.slice(0, 117)}...` : json;
  } catch {
    return String(args);
  }
}

export function truncateLine(text: string, width: number): string {
  const clean = text.replace(/\t/g, "  ");
  if (width <= 4 || clean.length <= width) return clean;
  return `${clean.slice(0, Math.max(1, width - 3))}...`;
}

/** Collapses a long tool result into the first N lines plus a remainder marker. */
export function summarizeToolOutput(output: string, firstLines = 3): string {
  const lines = output.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (lines.length <= firstLines) return lines.join("\n");
  return [
    ...lines.slice(0, firstLines),
    `... ${lines.length - firstLines} more line${lines.length - firstLines === 1 ? "" : "s"}`,
  ].join("\n");
}
