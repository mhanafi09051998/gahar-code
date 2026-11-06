import { isAbsolute, relative, sep } from "node:path";
import type { ApprovalAction, ResolvedPath, ToolContext, ToolResult } from "../contracts/tools.js";
import { toErrorMessage } from "../shared/errors.js";

export interface AccessRequest {
  tool: string;
  action: ApprovalAction;
  title: string;
  resource: string;
  detail?: string;
  insideWorkspace?: boolean;
  protectedPath?: boolean;
}

const PROTECTED_DIRS = new Set([".git", ".gahar"]);

function isWithin(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * True for writes that could turn an edit-only grant into code execution or
 * key theft: anything under a .git or .gahar directory (hooks, git config,
 * project config) and anything inside the global config directory.
 */
export function isProtectedPath(abs: string, cwd: string, configDir: string): boolean {
  if (isWithin(configDir, abs)) return true;
  if (!isWithin(cwd, abs)) return false;
  return relative(cwd, abs)
    .split(sep)
    .some((segment) => PROTECTED_DIRS.has(segment.toLowerCase()));
}

/** Asks the permission gate; returns a failed result when denied, otherwise null. */
export async function requirePermission(
  ctx: ToolContext,
  request: AccessRequest,
): Promise<ToolResult | null> {
  const decision = await ctx.permissions.ensure(request, ctx.signal);
  if (decision.allowed) return null;
  const reason = decision.reason ?? "permission denied";
  return { ok: false, output: `${request.tool}: permission denied: ${reason}` };
}

/** Asks before a mutating write to a file that is already known to be inside the workspace. */
export function requireWrite(
  ctx: ToolContext,
  tool: string,
  resolved: ResolvedPath,
  detail?: string,
): Promise<ToolResult | null> {
  const rel = ctx.paths.relative(resolved.abs);
  return requirePermission(ctx, {
    tool,
    action: "write",
    title: `${resolved.exists ? "Edit" : "Create"} ${rel}`,
    resource: resolved.abs,
    insideWorkspace: true,
    protectedPath: isProtectedPath(resolved.abs, ctx.cwd, ctx.config.configDir),
    ...(detail === undefined ? {} : { detail }),
  });
}

export type ReadableResult =
  | { resolved: ResolvedPath; denied?: undefined }
  | { denied: ToolResult };

/**
 * Resolves a path for reading. Paths outside the workspace are never touched
 * silently: they need an explicit "outside-workspace" approval first.
 */
export async function resolveReadable(
  ctx: ToolContext,
  tool: string,
  input: string,
): Promise<ReadableResult> {
  const resolved = await ctx.paths.resolveForRead(input, ctx.signal);
  if (resolved.inside) return { resolved };
  const denied = await requirePermission(ctx, {
    tool,
    action: "outside-workspace",
    title: `Read outside the workspace: ${resolved.abs}`,
    resource: resolved.abs,
    insideWorkspace: false,
  });
  return denied === null ? { resolved } : { denied };
}

/** Runs the read-before-write check, turning its error into a tool failure. */
export async function checkFresh(
  ctx: ToolContext,
  tool: string,
  abs: string,
): Promise<ToolResult | null> {
  try {
    await ctx.files.assertFresh(abs);
    return null;
  } catch (error) {
    return { ok: false, output: `${tool}: ${toErrorMessage(error)}` };
  }
}
