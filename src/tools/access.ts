import type { ApprovalAction, ResolvedPath, ToolContext, ToolResult } from "../contracts/tools.js";
import { toErrorMessage } from "../shared/errors.js";

export interface AccessRequest {
  tool: string;
  action: ApprovalAction;
  title: string;
  resource: string;
  detail?: string;
  insideWorkspace?: boolean;
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
