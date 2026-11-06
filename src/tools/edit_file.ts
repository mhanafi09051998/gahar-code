import { readFile, writeFile } from "node:fs/promises";

import { createTwoFilesPatch } from "diff";

import type { JsonSchema } from "../contracts/messages.js";
import type { Tool, ToolContext, ToolResult } from "../contracts/tools.js";
import { truncateMiddle } from "../shared/truncate.js";
import {
  asRecord,
  invalidArguments,
  optionalBoolean,
  requireString,
} from "./args.js";
import { booleanProperty, objectSchema, stringProperty } from "./schema.js";

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

export class EditFileTool implements Tool {
  readonly name = "edit_file";
  readonly description =
    "Replace an exact literal string in a file. The file must be read first. Fails when old_string is not unique unless replace_all is true.";
  readonly readOnly = false;
  readonly parameters: JsonSchema = objectSchema(
    {
      path: stringProperty("Path to the file, relative to the workspace."),
      old_string: stringProperty("Exact literal text to replace."),
      new_string: stringProperty("Replacement text."),
      replace_all: booleanProperty("Replace every occurrence instead of requiring uniqueness."),
    },
    ["path", "old_string", "new_string"],
  );

  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const args = asRecord(rawArgs, this.name);
      const path = requireString(args, "path");
      const oldString = requireString(args, "old_string");
      const newString = args.new_string;
      if (typeof newString !== "string") {
        return { ok: false, output: "invalid arguments: \"new_string\" must be a string (edit_file)" };
      }
      const replaceAll = optionalBoolean(args, "replace_all") ?? false;
      if (oldString === newString) {
        return { ok: false, output: "edit_file: old_string and new_string are identical; nothing to do" };
      }
      const resolved = await ctx.paths.resolveForWrite(path, ctx.signal);
      if (!resolved.exists || resolved.type !== "file") {
        return { ok: false, output: `edit_file: file not found: ${path}` };
      }
      try {
        await ctx.files.assertFresh(resolved.abs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, output: `edit_file: ${message}` };
      }
      const before = await readFile(resolved.abs, "utf8");
      const matches = countOccurrences(before, oldString);
      if (matches === 0) {
        return {
          ok: false,
          output: `edit_file: old_string was not found in ${path}. Read the file again and copy the exact text.`,
        };
      }
      if (matches > 1 && !replaceAll) {
        return {
          ok: false,
          output: `edit_file: old_string matches ${matches} times in ${path}. Add more surrounding context to make it unique, or pass replace_all: true.`,
        };
      }
      const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString);
      await ctx.snapshots.capture(resolved.abs);
      await writeFile(resolved.abs, after, "utf8");
      ctx.files.recordRead(resolved.abs, after);
      const diff = buildDiff(ctx.paths.relative(resolved.abs), before, after);
      const replaced = replaceAll ? matches : 1;
      return {
        ok: true,
        output: `Edited ${ctx.paths.relative(resolved.abs)} (${replaced} replacement${
          replaced === 1 ? "" : "s"
        })\n\n${diff}`,
        summary: `edit ${ctx.paths.relative(resolved.abs)}`,
      };
    } catch (error) {
      return invalidArguments(this.name, error);
    }
  }
}

export const editFileTool = new EditFileTool();
