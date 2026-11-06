import { readFile, writeFile } from "node:fs/promises";

import { createTwoFilesPatch } from "diff";

import type { ToolContext, ToolResult } from "../contracts/tools.js";
import { truncateMiddle } from "../shared/truncate.js";
import { checkFresh, requireWrite } from "./access.js";

export const MAX_DIFF_CHARS = 8000;

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export function buildDiff(path: string, before: string, after: string): string {
  const patch = createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, "", "", {
    context: 3,
  });
  return truncateMiddle(patch, MAX_DIFF_CHARS, "diff").text;
}

export type EditPlan = { ok: true; after: string; label: string } | { ok: false; error: string };

/**
 * Shared pipeline for in-place edits: path guard, read-before-write, plan,
 * permission (with the diff as detail), snapshot, write once, report a diff.
 */
export async function applyFileEdit(
  ctx: ToolContext,
  tool: string,
  path: string,
  plan: (before: string) => EditPlan,
): Promise<ToolResult> {
  const resolved = await ctx.paths.resolveForWrite(path, ctx.signal);
  if (!resolved.exists || resolved.type !== "file") {
    return { ok: false, output: `${tool}: file not found: ${path}` };
  }
  const stale = await checkFresh(ctx, tool, resolved.abs);
  if (stale !== null) return stale;
  const before = await readFile(resolved.abs, "utf8");
  const planned = plan(before);
  if (!planned.ok)
    return { ok: false, output: `${tool}: no changes were written: ${planned.error}` };
  const rel = ctx.paths.relative(resolved.abs);
  const diff = buildDiff(rel, before, planned.after);
  const denied = await requireWrite(ctx, tool, resolved, diff);
  if (denied !== null) return denied;
  await ctx.snapshots.capture(resolved.abs);
  await writeFile(resolved.abs, planned.after, "utf8");
  ctx.files.recordRead(resolved.abs, planned.after);
  return {
    ok: true,
    output: `Edited ${rel} (${planned.label})\n\n${diff}`,
    summary: `${tool} ${rel} (${planned.label})`,
    detail: diff,
  };
}
