import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { TodoItem } from "../contracts/todo.js";
import type { FileRegistry, TodoStore } from "../contracts/tools.js";

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function keyOf(absPath: string): string {
  const abs = resolve(absPath);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/**
 * Remembers what the model has seen. A write is only allowed when the file
 * was read in this session and has not changed on disk since.
 */
export class DefaultFileRegistry implements FileRegistry {
  private readonly seen = new Map<string, string>();

  recordRead(absPath: string, content: string): void {
    this.seen.set(keyOf(absPath), hash(content));
  }

  forget(absPath: string): void {
    this.seen.delete(keyOf(absPath));
  }

  async assertFresh(absPath: string): Promise<void> {
    const known = this.seen.get(keyOf(absPath));
    if (known === undefined) {
      throw new Error(
        `${absPath} has not been read yet in this session. Read it with read_file first.`,
      );
    }
    const current = await readFile(absPath, "utf8");
    if (hash(current) !== known) {
      throw new Error(
        `${absPath} changed on disk since it was last read. Read it again before editing.`,
      );
    }
  }
}

export class MemoryTodoStore implements TodoStore {
  private items: TodoItem[] = [];

  replace(items: TodoItem[]): void {
    this.items = items.map((item) => ({ ...item }));
  }

  list(): TodoItem[] {
    return this.items.map((item) => ({ ...item }));
  }
}
