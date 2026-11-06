import { readFile, writeFile } from "node:fs/promises";

import type { JsonSchema } from "../contracts/messages.js";
import type { Tool, ToolContext, ToolResult } from "../contracts/tools.js";
import { asRecord, invalidArguments, requireArray, requireString } from "./args.js";
import { buildDiff, countOccurrences } from "./edit_file.js";
import { arrayProperty, objectSchema, stringProperty } from "./schema.js";

interface PlannedEdit {
  oldString: string;
  newString: string;
  index: number;
  length: number;
}

/** Validate every edit against the original text, then apply them all at once. */
export function planEdits(
  original: string,
  edits: ReadonlyArray<{ oldString: string; newString: string }>,
): { ok: true; edits: PlannedEdit[] } | { ok: false; error: string } {
  if (edits.length === 0) return { ok: false, error: "no edits were supplied" };
  const planned: PlannedEdit[] = [];
  const seen = new Set<string>();
  for (const [index, edit] of edits.entries()) {
    const { oldString, newString } = edit;
    if (oldString.length === 0) {
      return { ok: false, error: `edit #${index + 1} has an empty old_string` };
    }
    if (oldString === newString) {
      return { ok: false, error: `edit #${index + 1} does not change anything` };
    }
    if (seen.has(oldString)) {
      return { ok: false, error: `edit #${index + 1} repeats the same old_string` };
    }
    const matches = countOccurrences(original, oldString);
    if (matches === 0) {
      return { ok: false, error: `edit #${index + 1} old_string was not found in the file` };
    }
    if (matches > 1) {
      return {
        ok: false,
        error: `edit #${index + 1} old_string matches ${matches} times; add more context`,
      };
    }
    seen.add(oldString);
    planned.push({
      oldString,
      newString,
      index: original.indexOf(oldString),
      length: oldString.length,
    });
  }
  planned.sort((a, b) => a.index - b.index);
  for (let i = 1; i < planned.length; i += 1) {
    const previous = planned[i - 1];
    const current = planned[i];
    if (previous !== undefined && current !== undefined && previous.index + previous.length > current.index) {
      return { ok: false, error: "edits overlap; apply them one at a time" };
    }
  }
  return { ok: true, edits: planned };
}

export function applyEdits(original: string, edits: ReadonlyArray<PlannedEdit>): string {
  let output = "";
  let cursor = 0;
  for (const edit of edits) {
    output += original.slice(cursor, edit.index) + edit.newString;
    cursor = edit.index + edit.length;
  }
  return output + original.slice(cursor);
}

export class MultiEditTool implements Tool {
  readonly name = "multi_edit";
  readonly description =
    "Apply several literal string edits to one file atomically. All edits are validated first; nothing is written unless every edit applies exactly once.";
  readonly readOnly = false;
  readonly parameters: JsonSchema = objectSchema(
    {
      path: stringProperty("Path to the file, relative to the workspace."),
      edits: arrayProperty("Ordered list of edits.", {
        type: "object",
        properties: {
          old_string: stringProperty("Exact literal text to replace."),
          new_string: stringProperty("Replacement text."),
        },
        required: ["old_string", "new_string"],
        additionalProperties: false,
      }),
    },
    ["path", "edits"],
  );

  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const args = asRecord(rawArgs, this.name);
      const path = requireString(args, "path");
      const rawEdits = requireArray(args, "edits");
      const edits = rawEdits.map((entry, index) => {
        const record = asRecord(entry, `edit #${index + 1}`);
        return {
          oldString: requireString(record, "old_string"),
          newString: (() => {
            const value = record.new_string;
            if (typeof value !== "string") {
              throw new Error(`edit #${index + 1} "new_string" must be a string`);
            }
            return value;
          })(),
        };
      });
      const resolved = await ctx.paths.resolveForWrite(path, ctx.signal);
      if (!resolved.exists || resolved.type !== "file") {
        return { ok: false, output: `multi_edit: file not found: ${path}` };
      }
      try {
        await ctx.files.assertFresh(resolved.abs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, output: `multi_edit: ${message}` };
      }
      const before = await readFile(resolved.abs, "utf8");
      const planned = planEdits(before, edits);
      if (!planned.ok) {
        return {
          ok: false,
          output: `multi_edit: no changes were written: ${planned.error}`,
        };
      }
      const after = applyEdits(before, planned.edits);
      await ctx.snapshots.capture(resolved.abs);
      await writeFile(resolved.abs, after, "utf8");
      ctx.files.recordRead(resolved.abs, after);
      const diff = buildDiff(ctx.paths.relative(resolved.abs), before, after);
      return {
        ok: true,
        output: `Edited ${ctx.paths.relative(resolved.abs)} (${planned.edits.length} edits)\n\n${diff}`,
        summary: `multi_edit ${ctx.paths.relative(resolved.abs)} (${planned.edits.length} edits)`,
      };
    } catch (error) {
      return invalidArguments(this.name, error);
    }
  }
}

export const multiEditTool = new MultiEditTool();
