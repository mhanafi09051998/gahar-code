import { stat, writeFile } from "node:fs/promises";

import type { JsonSchema } from "../contracts/messages.js";
import type { Tool, ToolContext, ToolResult } from "../contracts/tools.js";
import { isErrno } from "../shared/fsx.js";
import { formatBytes } from "../shared/truncate.js";
import { asRecord, invalidArguments, requireString } from "./args.js";
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
      const content = args.content;
      if (typeof content !== "string") {
        return { ok: false, output: "invalid arguments: \"content\" must be a string (write_file)" };
      }
      const resolved = await ctx.paths.resolveForWrite(path, ctx.signal);
      if (resolved.exists && resolved.type !== "file") {
        return { ok: false, output: `write_file: ${path} exists and is not a regular file` };
      }
      if (resolved.exists) {
        try {
          await ctx.files.assertFresh(resolved.abs);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, output: `write_file: ${message}` };
        }
        await ctx.snapshots.capture(resolved.abs);
      }
      await writeFile(resolved.abs, content, "utf8");
      ctx.files.forget(resolved.abs);
      const bytes = Buffer.byteLength(content, "utf8");
      const action = resolved.exists ? "update" : "create";
      return {
        ok: true,
        output: `${action === "create" ? "Created" : "Updated"} ${ctx.paths.relative(
          resolved.abs,
        )} (${formatBytes(bytes)})`,
        summary: `${action} ${ctx.paths.relative(resolved.abs)} ${formatBytes(bytes)}`,
        detail: action,
      };
    } catch (error) {
      return invalidArguments(this.name, error);
    }
  }
}

export const writeFileTool = new WriteFileTool();

/** Re-exported for tests that want the raw existence helper. */
export async function fileExistsByteSize(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.size;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}
