import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { JsonSchema } from "../contracts/messages.js";
import type { Tool, ToolContext, ToolResult } from "../contracts/tools.js";
import { formatBytes } from "../shared/truncate.js";
import { checkFresh, requireWrite } from "./access.js";
import { asRecord, invalidArguments, requireString, requireText } from "./args.js";
import { objectSchema, stringProperty } from "./schema.js";

export class WriteFileTool implements Tool {
  readonly name = "write_file";
  readonly description =
    "Create a file or overwrite it completely. An existing file must be read first with read_file.";
  readonly readOnly = false;
  readonly parameters: JsonSchema = objectSchema(
    {
      path: stringProperty("Path to write, relative to the workspace."),
      content: stringProperty("Full file content."),
    },
    ["path", "content"],
  );

  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const args = asRecord(rawArgs, this.name);
      const path = requireString(args, "path");
      const content = requireText(args, "content");
      const resolved = await ctx.paths.resolveForWrite(path, ctx.signal);
      if (resolved.exists && resolved.type !== "file") {
        return { ok: false, output: `write_file: ${path} exists and is not a regular file` };
      }
      if (resolved.exists) {
        const stale = await checkFresh(ctx, this.name, resolved.abs);
        if (stale !== null) return stale;
      }
      const bytes = Buffer.byteLength(content, "utf8");
      const denied = await requireWrite(ctx, this.name, resolved, formatBytes(bytes));
      if (denied !== null) return denied;
      // Captured even for new files so undo can delete what this call created.
      await ctx.snapshots.capture(resolved.abs);
      await mkdir(dirname(resolved.abs), { recursive: true });
      await writeFile(resolved.abs, content, "utf8");
      ctx.files.recordRead(resolved.abs, content);
      const rel = ctx.paths.relative(resolved.abs);
      const action = resolved.exists ? "update" : "create";
      return {
        ok: true,
        output: `${resolved.exists ? "Updated" : "Created"} ${rel} (${formatBytes(bytes)})`,
        summary: `${action} ${rel} ${formatBytes(bytes)}`,
        detail: action,
      };
    } catch (error) {
      return invalidArguments(this.name, error);
    }
  }
}

export const writeFileTool = new WriteFileTool();
