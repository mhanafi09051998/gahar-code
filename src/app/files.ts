import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { FileRegistry } from "../contracts/tools.js";
import { readTextFileIfExists } from "../shared/fsx.js";

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Remembers what the model has read so writes cannot clobber unseen or stale content. */
export class MemoryFileRegistry implements FileRegistry {
  private readonly hashes = new Map<string, string>();

  recordRead(absPath: string, content: string): void {
    this.hashes.set(resolve(absPath), digest(content));
  }

  async assertFresh(absPath: string): Promise<void> {
    const known = this.hashes.get(resolve(absPath));
    if (known === undefined) {
      throw new Error(`${absPath} has not been read yet; read it before writing to it`);
    }
    const current = await readTextFileIfExists(resolve(absPath));
    if (current !== null && digest(current) !== known) {
      throw new Error(`${absPath} changed since it was last read; read it again before writing`);
    }
  }

  forget(absPath: string): void {
    this.hashes.delete(resolve(absPath));
  }
}
