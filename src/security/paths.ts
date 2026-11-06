import { realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import type { PathGuard, ResolvedPath } from "../contracts/tools.js";
import { isErrno } from "../shared/fsx.js";

const DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/** Reason a path was rejected before any filesystem access. */
export class PathGuardError extends Error {
  readonly code: string;

  constructor(message: string, code = "path_rejected") {
    super(message);
    this.name = "PathGuardError";
    this.code = code;
  }
}

function isWindowsPath(input: string): boolean {
  if (process.platform !== "win32") return false;
  return /^[a-zA-Z]:[\\/]/.test(input) || input.startsWith("\\\\") || input.startsWith("//");
}

function assertNoDeviceName(input: string): void {
  const segments = input.split(/[\\/]+/);
  for (const raw of segments) {
    const segment = raw.split(":")[0] ?? "";
    const stem = segment.split(".")[0] ?? "";
    if (stem.length === 0) continue;
    if (DEVICE_NAMES.has(stem.toLowerCase())) {
      throw new PathGuardError(
        `refusing to use Windows reserved device name "${segment}": rename the file and retry`,
        "device_name",
      );
    }
  }
}

/** Normalise a path lexically: resolve relative input, collapse "." and "..". */
export function normalizePath(input: string, cwd: string): string {
  return isWindowsPath(input) ? resolve(input) : resolve(cwd, input);
}

function trimTrailingSeparators(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  return trimmed.length === 0 ? value : trimmed;
}

/** Containment with a trailing-separator guard: "C:\\foobar" is not inside "C:\\foo". */
export function isInsidePath(child: string, parent: string): boolean {
  const childNorm = trimTrailingSeparators(child);
  const parentNorm = trimTrailingSeparators(parent);
  if (childNorm.toLowerCase() === parentNorm.toLowerCase()) return true;
  return childNorm.toLowerCase().startsWith((parentNorm + sep).toLowerCase());
}

function lexicalParent(value: string): string | null {
  const resolved = resolve(value);
  const parent = resolve(resolved, "..");
  return parent === resolved ? null : parent;
}

function toRelative(abs: string, cwd: string): string {
  const rel = relative(cwd, abs);
  return rel.split(sep).join("/");
}

export interface PathGuardOptions {
  cwd: string;
  workspaceRoot?: string;
}

/**
 * Walk up from candidate until an existing ancestor is found, then realpath it
 * so symlinks and Windows junctions cannot be used to escape the workspace.
 */
async function realpathNearestAncestor(candidate: string): Promise<string> {
  let current = resolve(candidate);
  for (let hop = 0; hop < 64; hop += 1) {
    try {
      return await realpath(current);
    } catch (error) {
      if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTDIR")) return current;
    }
    const parent = lexicalParent(current);
    if (parent === null) return current;
    current = parent;
  }
  return current;
}

export class DefaultPathGuard implements PathGuard {
  readonly cwd: string;
  readonly workspaceRoot: string;

  constructor(options: PathGuardOptions) {
    this.cwd = resolve(options.cwd);
    this.workspaceRoot = resolve(options.workspaceRoot ?? options.cwd);
  }

  private reject(input: string): never {
    throw new PathGuardError("path must be a non-empty string", "invalid_path");
  }

  private resolveInput(input: string): string {
    if (typeof input !== "string" || input.trim().length === 0) this.reject(input);
    if (input.includes("\u0000")) {
      throw new PathGuardError("path contains a NUL byte", "nul_byte");
    }
    const withBase = isWindowsPath(input) ? input : join(this.cwd, input);
    assertNoDeviceName(withBase);
    return resolve(withBase);
  }

  private async build(abs: string, input: string): Promise<ResolvedPath> {
    // The lexical path is the primary check; realpath of the nearest existing
    // ancestor catches symlink and junction escapes (including dangling links).
    const lexical = await this.lexical(abs, input);
    if (!lexical.inside) return lexical;
    const real = await realpathNearestAncestor(abs);
    const inside = isInsidePath(real, this.workspaceRoot);
    return { ...lexical, inside };
  }

  private async lexical(abs: string, input: string): Promise<ResolvedPath> {
    const inside = isInsidePath(abs, this.workspaceRoot);
    let type: ResolvedPath["type"] = "missing";
    let exists = false;
    try {
      const info = await stat(abs);
      exists = true;
      type = info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
    } catch (error) {
      if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTDIR")) {
        type = "other";
      }
    }
    return { abs, input, inside, exists, type };
  }

  async resolveForRead(input: string, _signal?: AbortSignal): Promise<ResolvedPath> {
    const abs = this.resolveInput(input);
    // Reads outside the workspace are returned unresolved-but-flagged; the
    // caller must clear the permission gate first, nothing is read silently.
    return this.build(abs, input);
  }

  async resolveForWrite(input: string, _signal?: AbortSignal): Promise<ResolvedPath> {
    const abs = this.resolveInput(input);
    const resolved = await this.build(abs, input);
    if (!resolved.inside) {
      throw new PathGuardError(
        `refusing to write outside the workspace: "${input}" escapes ${this.workspaceRoot}`,
        "outside_workspace",
      );
    }
    return resolved;
  }

  relative(abs: string): string {
    return toRelative(resolve(abs), this.workspaceRoot);
  }

  isInside(abs: string): boolean {
    return isInsidePath(resolve(abs), this.workspaceRoot);
  }
}

export function createPathGuard(cwd: string, workspaceRoot?: string): PathGuard {
  return new DefaultPathGuard({ cwd, workspaceRoot });
}
