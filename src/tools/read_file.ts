import { readFile, stat } from "node:fs/promises";

import type { JsonSchema } from "../contracts/messages.js";
import type { Tool, ToolContext, ToolResult } from "../contracts/tools.js";
import { MAX_READ_LINES } from "../shared/defaults.js";
import { formatBytes, truncateMiddle } from "../shared/truncate.js";
import { resolveReadable } from "./access.js";
import { asRecord, clampInteger, invalidArguments, optionalNumber, requireString } from "./args.js";
import { numberProperty, objectSchema, stringProperty } from "./schema.js";

/** Output cap for one read; page through bigger files with offset/limit. */
export const MAX_READ_OUTPUT_CHARS = 100 * 1024;
/** Files above this size are refused outright. */
export const MAX_READ_FILE_BYTES = 10 * 1024 * 1024;
const MAX_LINE_CHARS = 2000;
const BINARY_SNIFF_BYTES = 8192;

export function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

function renderLines(lines: readonly string[], firstLine: number): string {
  return lines
    .map((line, index) => {
      const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} ...` : line;
      return `${String(firstLine + index).padStart(5)}|${shown}`;
    })
    .join("\n");
}

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
    try {
      const args = asRecord(rawArgs, this.name);
      const path = requireString(args, "path");
      const offset = clampInteger(optionalNumber(args, "offset"), 1, Number.MAX_SAFE_INTEGER, 1);
      const limit = clampInteger(optionalNumber(args, "limit"), 1, MAX_READ_LINES, MAX_READ_LINES);

      const access = await resolveReadable(ctx, this.name, path);
      if (access.denied) return access.denied;
      const { resolved } = access;
      if (!resolved.exists) return { ok: false, output: `read_file: file not found: ${path}` };
      if (resolved.type === "directory") {
        return { ok: false, output: `read_file: ${path} is a directory; use list_dir instead` };
      }
      const size = (await stat(resolved.abs)).size;
      if (size > MAX_READ_FILE_BYTES) {
        return {
          ok: false,
          output: `read_file: ${path} is ${formatBytes(size)}, above the ${formatBytes(MAX_READ_FILE_BYTES)} limit. Use grep or run_command to inspect it.`,
        };
      }
      const buffer = await readFile(resolved.abs);
      if (looksBinary(buffer)) {
        return {
          ok: false,
          output: `read_file: ${path} looks like a binary file; read_file only handles UTF-8 text`,
        };
      }
      const content = buffer.toString("utf8");
      ctx.files.recordRead(resolved.abs, content);
      const allLines = content.split(/\r?\n/);
      const slice = allLines.slice(offset - 1, offset - 1 + limit);
      const nextLine = offset + slice.length;
      const remaining = allLines.length - (nextLine - 1);
      const footer =
        remaining > 0
          ? `\n... [${remaining} more lines; continue with offset=${nextLine}] ...`
          : "";
      const body = truncateMiddle(
        renderLines(slice, offset) + footer,
        MAX_READ_OUTPUT_CHARS,
        "file content",
      );
      const rel = ctx.paths.relative(resolved.abs);
      return { ok: true, output: body.text, summary: `read ${rel} (${slice.length} lines)` };
    } catch (error) {
      return invalidArguments(this.name, error);
    }
  }
}

export const readFileTool = new ReadFileTool();
