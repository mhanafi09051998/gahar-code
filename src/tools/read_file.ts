import { readFile, stat } from "node:fs/promises";

import type { JsonSchema } from "../contracts/messages.js";
import type { Tool, ToolContext, ToolResult } from "../contracts/tools.js";
import { MAX_READ_LINES } from "../shared/defaults.js";
import { isProbablyBinary } from "../shared/fsx.js";
import { formatBytes, truncateMiddle } from "../shared/truncate.js";
import { asRecord, clampInteger, invalidArguments, optionalNumber, requireString } from "./args.js";
import { numberProperty, objectSchema, stringProperty } from "./schema.js";

const MAX_READ_BYTES = 100 * 1024;
const MAX_LINE_CHARS = 2000;

export class ReadFileTool implements Tool {
  readonly name = "read_file";
  readonly description =
    "Read a UTF-8 text file from the workspace. Output includes line numbers. Use offset and limit for large files.";
  readonly readOnly = true;
  readonly parameters: JsonSchema = objectSchema(
    {
      path: stringProperty("Path to the file, relative to the workspace or absolute."),
      offset: numberProperty("1-based line number to start reading from."),
      limit: numberProperty(`Maximum number of lines to return (max ${MAX_READ_LINES}).`),
    },
    ["path"],
  );

  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    let path = "";
    try {
      const args = asRecord(rawArgs, this.name);
      path = requireString(args, "path");
      const offset = clampInteger(optionalNumber(args, "offset"), 1, Number.MAX_SAFE_INTEGER, 1);
      const limit = clampInteger(optionalNumber(args, "limit"), 1, MAX_READ_LINES, MAX_READ_LINES);

      const resolved = await ctx.paths.resolveForRead(path, ctx.signal);
      if (!resolved.exists) {
        return { ok: false, output: `read_file: file not found: ${path}` };
      }
      if (resolved.type === "directory") {
        return { ok: false, output: `read_file: ${path} is a directory; use list_dir instead` };
      }
      if (!resolved.inside) {
        return {
          ok: false,
          output: `read_file: refusing to read outside the workspace: ${path}`,
        };
      }
      const info = await stat(resolved.abs);
      if (info.size > MAX_READ_BYTES) {
        return {
          ok: false,
          output: `read_file: ${path} is ${formatBytes(info.size)} which exceeds the ${formatBytes(
            MAX_READ_BYTES,
          )} read cap. Use offset/limit on a smaller file or run_command with a filter.`,
        };
      }
      if (await isProbablyBinary(resolved.abs)) {
        return {
          ok: false,
          output: `read_file: ${path} looks like a binary file; read_file only handles UTF-8 text`,
        };
      }
      const content = await readFile(resolved.abs, "utf8");
      ctx.files.recordRead(resolved.abs, content);
      const allLines = content.split(/\r?\n/);
      const slice = allLines.slice(offset - 1, offset - 1 + limit);
      const rendered = slice
        .map((line, index) => {
          const shown = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line;
          return `${String(offset + index).padStart(5)}|${shown}`;
        })
        .join("\n");
      const truncated = offset - 1 + limit < allLines.length;
      const footer = truncated
        ? `\n... [${allLines.length - (offset - 1 + slice.length)} more lines; continue with offset=${
            offset + slice.length
          }] ...`
        : "";
      const body = truncateMiddle(rendered + footer, 60_000, "file content");
      return {
        ok: true,
        output: body.text,
        summary: `read ${ctx.paths.relative(resolved.abs)} (${slice.length} lines)`,
      };
    } catch (error) {
      return invalidArguments(this.name, error);
    }
  }
}

export const readFileTool = new ReadFileTool();
