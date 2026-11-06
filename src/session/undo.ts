import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ensureDir, isErrno, pathExists, readTextFileIfExists, removePath } from "../shared/fsx.js";
import { atomicWriteFile } from "../shared/fsx.js";

export const MAX_UNDO_TURNS = 20;

export interface SnapshotEntry {
  /** Absolute path of the captured file. */
  abs: string;
  /** Path relative to the snapshot turn directory. */
  stored: string;
  /** Whether the file existed before the capture. */
  existed: boolean;
  /** Whether the original was binary (stored as a copy, not text). */
  binary: boolean;
}

export interface TurnIndex {
  turn: number;
  createdAt: string;
  entries: SnapshotEntry[];
}

export interface UndoOptions {
  snapshotsDir: string;
  cwd: string;
  maxTurns?: number;
  now?: () => Date;
}

/** Captures file contents per turn so a turn can be reverted. */
export class UndoManager {
  private readonly snapshotsDir: string;
  private readonly cwd: string;
  private readonly maxTurns: number;
  private readonly now: () => Date;
  private currentTurn = 0;

  constructor(options: UndoOptions) {
    this.snapshotsDir = options.snapshotsDir;
    this.cwd = options.cwd;
    this.maxTurns = options.maxTurns ?? MAX_UNDO_TURNS;
    this.now = options.now ?? (() => new Date());
  }

  get turn(): number {
    return this.currentTurn;
  }

  /** Starts a new turn; returns its index. */
  beginTurn(): number {
    this.currentTurn += 1;
    return this.currentTurn;
  }

  private turnDir(turn: number): string {
    return join(this.snapshotsDir, String(turn));
  }

  private indexPath(turn: number): string {
    return join(this.turnDir(turn), "index.json");
  }

  /** Copies the file into snapshots/<turn>/ before it is modified. */
  async capture(absPath: string, turn = this.currentTurn): Promise<void> {
    const abs = resolve(absPath);
    const index = await this.readIndex(turn);
    if (index.entries.some((entry) => entry.abs === abs)) return;
    const stored = this.storedName(abs);
    const dir = this.turnDir(turn);
    await ensureDir(dir);
    const existed = await pathExists(abs);
    let binary = false;
    if (existed) {
      const buffer = await readFile(abs);
      binary = buffer.includes(0);
      await atomicWriteFile(join(dir, stored), buffer.toString("base64"));
    }
    index.entries.push({ abs, stored, existed, binary });
    index.createdAt = this.now().toISOString();
    await atomicWriteFile(this.indexPath(turn), `${JSON.stringify(index, null, 2)}\n`);
  }

  private storedName(abs: string): string {
    const rel = relative(this.cwd, abs);
    if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) {
      return rel.split(sep).join("/");
    }
    return `_external/${createHash("sha256").update(abs).digest("hex").slice(0, 16)}`;
  }

  private async readIndex(turn: number): Promise<TurnIndex> {
    const raw = await readTextFileIfExists(this.indexPath(turn));
    if (raw === null) return { turn, createdAt: this.now().toISOString(), entries: [] };
    try {
      const parsed = JSON.parse(raw) as TurnIndex;
      if (!parsed || !Array.isArray(parsed.entries)) throw new Error("bad index");
      return { turn, createdAt: parsed.createdAt ?? "", entries: parsed.entries };
    } catch {
      return { turn, createdAt: this.now().toISOString(), entries: [] };
    }
  }

  /** Lists turns that have snapshots, newest first. */
  async listTurns(): Promise<number[]> {
    let entries: string[];
    try {
      entries = await readdir(this.snapshotsDir);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    return entries
      .map((name) => Number(name))
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((a, b) => b - a);
  }

  /** Restores every file captured in a turn; returns the restored paths. */
  async restoreTurn(turn: number): Promise<string[]> {
    const index = await this.readIndex(turn);
    const restored: string[] = [];
    for (const entry of index.entries) {
      const storedPath = join(this.turnDir(turn), entry.stored);
      if (!entry.existed) {
        await removePath(entry.abs);
        restored.push(entry.abs);
        continue;
      }
      const encoded = await readTextFileIfExists(storedPath);
      if (encoded === null) continue;
      const buffer = Buffer.from(encoded, "base64");
      await ensureDir(dirname(entry.abs));
      await atomicWriteFile(entry.abs, buffer.toString("utf8"));
      restored.push(entry.abs);
    }
    await removePath(this.turnDir(turn));
    return restored;
  }

  /** Restores the most recent turn that still has snapshots. */
  async undoLast(): Promise<{ turn: number; restored: string[] } | null> {
    const turns = await this.listTurns();
    const turn = turns[0];
    if (turn === undefined) return null;
    const restored = await this.restoreTurn(turn);
    return { turn, restored };
  }

  /** Drops the oldest turns beyond maxTurns. */
  async prune(): Promise<void> {
    const turns = await this.listTurns();
    for (const turn of turns.slice(this.maxTurns)) {
      await removePath(this.turnDir(turn));
    }
  }

  async hasSnapshots(): Promise<boolean> {
    const turns = await this.listTurns();
    return turns.length > 0;
  }

  async fileSizeOf(absPath: string): Promise<number> {
    try {
      return (await stat(absPath)).size;
    } catch {
      return 0;
    }
  }
}
