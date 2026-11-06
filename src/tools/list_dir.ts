import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { JsonSchema } from "../contracts/messages.js";
import type { Tool, ToolContext, ToolResult } from "../contracts/tools.js";
import { formatBytes } from "../shared/truncate.js";
import { resolveReadable } from "./access.js";
import {
  asRecord,
  clampInteger,
  invalidArguments,
  optionalNumber,
  optionalString,
} from "./args.js";
import { numberProperty, objectSchema, stringProperty } from "./schema.js";

const DEFAULT_SKIP = new Set([".git", "node_modules"]);
const MAX_ENTRIES = 500;
const MAX_DEPTH_CAP = 3;

interface Entry {
  rel: string;
  size: number | null;
  kind: "file" | "directory" | "other";
}

async function walk(
  base: string,
  rel: string,
  depth: number,
  maxDepth: number,
  out: Entry[],
  skip: ReadonlySet<string>,
): Promise<void> {
  if (out.length >= MAX_ENTRIES) return;
  const entries = await readdir(join(base, rel), { withFileTypes: true });
  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    if (out.length >= MAX_ENTRIES) return;
    if (skip.has(entry.name)) continue;
    const childRel = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push({ rel: `${childRel}/`, size: null, kind: "directory" });
      if (depth < maxDepth) await walk(base, childRel, depth + 1, maxDepth, out, skip);
      continue;
    }
    let size: number | null = null;
    try {
      size = (await stat(join(base, childRel))).size;
    } catch {
      size = null;
    }
    out.push({ rel: childRel, size, kind: entry.isFile() ? "file" : "other" });
  }
}

export class ListDirTool implements Tool {
  readonly name = "list_dir";
  readonly description =
    "List the entries of a directory with type and size. .git and node_modules are skipped.";
  readonly readOnly = true;
  readonly parameters: JsonSchema = objectSchema(
    {
      path: stringProperty(
        "Directory to list, relative to the workspace. Defaults to the workspace root.",
      ),
      depth: numberProperty(`How deep to recurse (1-${MAX_DEPTH_CAP}, default 1).`),
    },
    [],
  );

  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const args = asRecord(rawArgs, this.name);
      const input = optionalString(args, "path") ?? ".";
      const depth = clampInteger(optionalNumber(args, "depth"), 1, MAX_DEPTH_CAP, 1);
      const access = await resolveReadable(ctx, this.name, input);
      if (access.denied) return access.denied;
      const { resolved } = access;
      if (!resolved.exists) {
        return { ok: false, output: `list_dir: directory not found: ${input}` };
      }
      if (resolved.type !== "directory") {
        return { ok: false, output: `list_dir: ${input} is not a directory` };
      }
      const entries: Entry[] = [];
      await walk(resolved.abs, "", 1, depth, entries, DEFAULT_SKIP);
      if (entries.length === 0) {
        return { ok: true, output: `${input} is empty (or only contains .git/node_modules)` };
      }
      const lines = entries.map((entry) => {
        if (entry.kind === "directory") return `  ${entry.rel}`;
        const size = entry.size === null ? "?" : formatBytes(entry.size);
        return `  ${entry.rel}  ${size}`;
      });
      const capped =
        entries.length >= MAX_ENTRIES ? `\n... [capped at ${MAX_ENTRIES} entries] ...` : "";
      return {
        ok: true,
        output: `${ctx.paths.relative(resolved.abs)}/\n${lines.join("\n")}${capped}`,
        summary: `listed ${entries.length} entries`,
      };
    } catch (error) {
      return invalidArguments(this.name, error);
    }
  }
}

export const listDirTool = new ListDirTool();
