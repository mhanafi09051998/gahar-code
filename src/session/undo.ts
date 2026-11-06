import { createHash } from "node:crypto";
import { copyFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SnapshotStore } from "../contracts/tools.js";
import {
  atomicWriteFile,
  ensureDir,
  isErrno,
  pathExists,
  readTextFileIfExists,
  removePath,
} from "../shared/fsx.js";

export const MAX_UNDO_TURNS = 20;

export interface SnapshotEntry {
  /** Absolute path of the captured file. */
  abs: string;
  /** Path of the copy, relative to the snapshot turn directory. */
  stored: string;
  /** Whether the file existed before the capture. */
  existed: boolean;
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

/** Captures file contents per turn so a whole turn can be reverted. */
export class UndoManager implements SnapshotStore {
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

  /** Starts a new turn after any turn already on disk (safe across resumes) and prunes old ones. */
  async beginTurn(): Promise<number> {
    const latest = (await this.listTurns())[0] ?? 0;
    this.currentTurn = Math.max(this.currentTurn, latest) + 1;
    await this.prune(this.maxTurns - 1);
    return this.currentTurn;
  }

  private turnDir(turn: number): string {
    return join(this.snapshotsDir, String(turn));
  }

  private indexPath(turn: number): string {
    return join(this.turnDir(turn), "index.json");
  }

  /** Copies the file into snapshots/<turn>/files/ before its first change in the turn. */
  async capture(absPath: string): Promise<void> {
    if (this.currentTurn === 0) await this.beginTurn();
    const turn = this.currentTurn;
    const abs = resolve(absPath);
    const index = await this.readIndex(turn);
    if (index.entries.some((entry) => entry.abs === abs)) return;
    const stored = this.storedName(abs);
    const existed = await pathExists(abs);
    if (existed) {
      const target = join(this.turnDir(turn), stored);
      await ensureDir(dirname(target));
      await copyFile(abs, target);
    }
    index.entries.push({ abs, stored, existed });
    await atomicWriteFile(this.indexPath(turn), `${JSON.stringify(index, null, 2)}\n`);
  }

  private storedName(abs: string): string {
    const rel = relative(this.cwd, abs);
    if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) {
      return `files/${rel.split(sep).join("/")}`;
    }
    return `external/${createHash("sha256").update(abs).digest("hex").slice(0, 16)}`;
  }

  private async readIndex(turn: number): Promise<TurnIndex> {
    const empty: TurnIndex = { turn, createdAt: this.now().toISOString(), entries: [] };
    const raw = await readTextFileIfExists(this.indexPath(turn));
    if (raw === null) return empty;
    try {
      const parsed = JSON.parse(raw) as Partial<TurnIndex>;
      if (!Array.isArray(parsed.entries)) return empty;
      return { turn, createdAt: parsed.createdAt ?? empty.createdAt, entries: parsed.entries };
    } catch {
      return empty;
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

  /** Restores every file captured in a turn (deleting files it created); returns their paths. */
  async restoreTurn(turn: number): Promise<string[]> {
    const index = await this.readIndex(turn);
    const restored: string[] = [];
    for (const entry of index.entries) {
      if (!entry.existed) {
        await removePath(entry.abs);
        restored.push(entry.abs);
        continue;
      }
      const storedPath = join(this.turnDir(turn), entry.stored);
      if (!(await pathExists(storedPath))) continue;
      await ensureDir(dirname(entry.abs));
      await copyFile(storedPath, entry.abs);
      restored.push(entry.abs);
    }
    await removePath(this.turnDir(turn));
    return restored;
  }

  /** Restores the most recent turn that still has snapshots. */
  async undoLast(): Promise<{ turn: number; restored: string[] } | null> {
    const turn = (await this.listTurns())[0];
    if (turn === undefined) return null;
    const restored = await this.restoreTurn(turn);
    return { turn, restored };
  }

  /** Keeps only the newest `keep` turns on disk. */
  async prune(keep = this.maxTurns): Promise<void> {
    const turns = await this.listTurns();
    for (const turn of turns.slice(Math.max(0, keep))) {
      await removePath(this.turnDir(turn));
    }
  }

  async hasSnapshots(): Promise<boolean> {
    return (await this.listTurns()).length > 0;
  }
}
