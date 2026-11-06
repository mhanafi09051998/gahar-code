import type { GaharEvent } from "../contracts/events.js";
import type { Writable } from "./env.js";

export interface JsonEventWriterOptions {
  stdout: Writable;
  enabled: boolean;
}

/**
 * Serializes GaharEvent objects to stdout as JSONL. In non-JSON mode every
 * method is a safe no-op so callers can wire it unconditionally.
 */
export class JsonEventWriter {
  private readonly out: Writable;
  private readonly enabled: boolean;

  constructor(options: JsonEventWriterOptions) {
    this.out = options.stdout;
    this.enabled = options.enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  emit(event: GaharEvent): void {
    if (!this.enabled) return;
    this.out.write(`${serialize(event)}\n`);
  }

  /** Emits a synthetic error event without a session (used before init). */
  emitError(message: string, code?: string): void {
    this.emit({
      type: "error",
      at: new Date().toISOString(),
      message,
      ...(code === undefined ? {} : { code }),
    });
  }
}

export function serialize(event: GaharEvent): string {
  try {
    return JSON.stringify(event);
  } catch {
    return JSON.stringify({
      type: "error",
      message: "unserializable event",
      at: new Date().toISOString(),
    });
  }
}

export function parseEventLine(line: string): GaharEvent | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof (parsed as { type?: unknown }).type !== "string") return null;
    return parsed as GaharEvent;
  } catch {
    return null;
  }
}
