import type { JsonSchema } from "../contracts/messages.js";
import type { Tool, ToolContext, ToolResult } from "../contracts/tools.js";
import { asRecord, invalidArguments, optionalBoolean, requireString, requireText } from "./args.js";
import type { EditPlan } from "./file_edit.js";
import { applyFileEdit, countOccurrences, toLf } from "./file_edit.js";
import { booleanProperty, objectSchema, stringProperty } from "./schema.js";

export function planReplace(
  before: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): EditPlan {
  const matches = countOccurrences(before, oldString);
  if (matches === 0) {
    return {
      ok: false,
      error: "old_string was not found. Read the file again and copy the exact text.",
    };
  }
  if (matches > 1 && !replaceAll) {
    return {
      ok: false,
      error: `old_string matches ${matches} times. Add more surrounding context to make it unique, or pass replace_all: true.`,
    };
  }
  // A replacer function keeps "$&" and friends in new_string literal.
  const after = replaceAll
    ? before.split(oldString).join(newString)
    : before.replace(oldString, () => newString);
  const replaced = replaceAll ? matches : 1;
  return { ok: true, after, label: `${replaced} replacement${replaced === 1 ? "" : "s"}` };
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
      const oldString = toLf(requireString(args, "old_string"));
      const newString = toLf(requireText(args, "new_string"));
      const replaceAll = optionalBoolean(args, "replace_all") ?? false;
      if (oldString === newString) {
        return {
          ok: false,
          output: "edit_file: old_string and new_string are identical; nothing to do",
        };
      }
      return await applyFileEdit(ctx, this.name, path, (before) =>
        planReplace(before, oldString, newString, replaceAll),
      );
    } catch (error) {
      return invalidArguments(this.name, error);
    }
  }
}

export const editFileTool = new EditFileTool();
