import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { PathGuard, ResolvedPath } from "../contracts/tools.js";
import { isErrno } from "../shared/fsx.js";

const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_LINK_HOPS = 64;
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

/** Reason a path was rejected before any filesystem access. */
export class PathGuardError extends Error {
  readonly code: string;

  constructor(message: string, code = "path_rejected") {
    super(message);
    this.name = "PathGuardError";
    this.code = code;
  }
}

/** Rejects Windows reserved device names (CON, NUL, COM1, "aux.txt", "nul:stream"). */
export function assertNoDeviceName(input: string): void {
  for (const segment of input.split(/[\\/]+/)) {
    const stem = (segment.split(":")[0] ?? "").split(".")[0] ?? "";
    if (DEVICE_NAME.test(stem.trimEnd())) {
      throw new PathGuardError(
        `refusing to use Windows reserved device name "${segment}": rename the file and retry`,
        "device_name",
      );
    }
  }
}

function trimTrailingSeparators(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  return trimmed.length === 0 ? value : trimmed;
}

/** Containment with a trailing-separator guard: "C:\\foobar" is not inside "C:\\foo". */
export function isInsidePath(
  child: string,
  parent: string,
  caseInsensitive = CASE_INSENSITIVE,
): boolean {
  const fold = (value: string): string => (caseInsensitive ? value.toLowerCase() : value);
  const childNorm = fold(trimTrailingSeparators(child));
  const parentNorm = fold(trimTrailingSeparators(parent));
  if (childNorm === parentNorm) return true;
  const prefix = /[\\/]$/.test(parentNorm) ? parentNorm : parentNorm + sep;
  return childNorm.startsWith(prefix);
}

/**
 * Realpath the nearest existing ancestor so symlinks and Windows junctions
 * cannot escape the workspace. A dangling link is followed to its target, so a
 * write through it cannot create a file outside either.
 */
export async function realpathNearestAncestor(candidate: string): Promise<string> {
  let current = resolve(candidate);
  const missing: string[] = [];
  for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
    try {
      return resolve(await realpath(current), ...missing);
    } catch (error) {
      if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTDIR")) throw error;
    }
    const target = await danglingLinkTarget(current);
    if (target !== null) {
      current = target;
      continue;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(current, ...missing);
    missing.unshift(basename(current));
    current = parent;
  }
  throw new PathGuardError("too many symbolic links while resolving path", "link_loop");
}

async function danglingLinkTarget(path: string): Promise<string | null> {
  try {
    if (!(await lstat(path)).isSymbolicLink()) return null;
    return resolve(dirname(path), await readlink(path));
  } catch {
    return null;
  }
}

async function describe(abs: string): Promise<Pick<ResolvedPath, "exists" | "type">> {
  try {
    const info = await stat(abs);
    const type = info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
    return { exists: true, type };
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
      return { exists: false, type: "missing" };
    }
    return { exists: false, type: "other" };
  }
}

export interface PathGuardOptions {
  cwd: string;
  workspaceRoot?: string | undefined;
}

export class DefaultPathGuard implements PathGuard {
  readonly cwd: string;
  readonly workspaceRoot: string;
  private realRoot: Promise<string> | undefined;

  constructor(options: PathGuardOptions) {
    this.cwd = resolve(options.cwd);
    this.workspaceRoot = resolve(options.workspaceRoot ?? options.cwd);
  }

  private resolveInput(input: unknown): string {
    if (typeof input !== "string" || input.trim().length === 0) {
      throw new PathGuardError("path must be a non-empty string", "invalid_path");
    }
    if (input.includes("\u0000")) {
      throw new PathGuardError("path contains a NUL byte", "nul_byte");
    }
    assertNoDeviceName(input);
    return resolve(this.cwd, input);
  }

  /** The workspace root itself may sit behind a link (macOS /tmp, Windows 8.3 names). */
  private realWorkspaceRoot(): Promise<string> {
    this.realRoot ??= realpathNearestAncestor(this.workspaceRoot);
    return this.realRoot;
  }

  private async build(abs: string, input: string): Promise<ResolvedPath> {
    let inside = isInsidePath(abs, this.workspaceRoot);
    if (inside) {
      const [real, root] = await Promise.all([
        realpathNearestAncestor(abs),
        this.realWorkspaceRoot(),
      ]);
      inside = isInsidePath(real, root);
    }
    return { abs, input, inside, ...(await describe(abs)) };
  }

  /**
   * Reads outside the workspace come back flagged (inside: false); the tool
   * must clear the permission gate before touching them.
   */
  async resolveForRead(input: string, _signal?: AbortSignal): Promise<ResolvedPath> {
    return this.build(this.resolveInput(input), input);
  }

  async resolveForWrite(input: string, _signal?: AbortSignal): Promise<ResolvedPath> {
    const resolved = await this.build(this.resolveInput(input), input);
    if (!resolved.inside) {
      throw new PathGuardError(
        `refusing to write outside the workspace: "${input}" escapes ${this.workspaceRoot}`,
        "outside_workspace",
      );
    }
    return resolved;
  }

  relative(abs: string): string {
    const rel = relative(this.workspaceRoot, resolve(abs));
    if (rel.length === 0) return ".";
    return isAbsolute(rel) ? resolve(abs) : rel.split(sep).join("/");
  }

  isInside(abs: string): boolean {
    return isInsidePath(resolve(abs), this.workspaceRoot);
  }
}

export function createPathGuard(cwd: string, workspaceRoot?: string): DefaultPathGuard {
  return new DefaultPathGuard({ cwd, workspaceRoot });
}
