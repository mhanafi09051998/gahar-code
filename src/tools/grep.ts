import { readFile, stat } from "node:fs/promises";
import { relative, sep } from "node:path";

import fg from "fast-glob";

import type { JsonSchema } from "../contracts/messages.js";
import type { Tool, ToolContext, ToolResult } from "../contracts/tools.js";
import { resolveReadable } from "./access.js";
import {
  asRecord,
  invalidArguments,
  optionalBoolean,
  optionalString,
  requireContainedPattern,
  requireString,
} from "./args.js";
import { booleanProperty, objectSchema, stringProperty } from "./schema.js";

const MAX_MATCHES = 250;
const MAX_FILE_BYTES = 1024 * 1024;

export class GrepTool implements Tool {
  readonly name = "grep";
  readonly description =
    "Search file contents with a JavaScript regular expression, similar to ripgrep.";
  readonly readOnly = true;
  readonly parameters: JsonSchema = objectSchema(
    {
      pattern: stringProperty("JavaScript regular expression to search for."),
      include: stringProperty(
        'Optional glob filter, for example "**/*.ts". Defaults to all files.',
      ),
      path: stringProperty("Directory to search, relative to the workspace."),
      ignore_case: booleanProperty("Case-insensitive search."),
    },
    ["pattern"],
  );

  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const args = asRecord(rawArgs, this.name);
      const pattern = requireString(args, "pattern");
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, optionalBoolean(args, "ignore_case") === true ? "gi" : "g");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, output: `grep: invalid regular expression "${pattern}": ${message}` };
      }
      const include = requireContainedPattern(optionalString(args, "include") ?? "**/*", "include");
      const inputPath = optionalString(args, "path");
      let searchRoot = ctx.cwd;
      if (inputPath !== undefined) {
        const access = await resolveReadable(ctx, this.name, inputPath);
        if (access.denied) return access.denied;
        if (access.resolved.type !== "directory") {
          return {
            ok: false,
            output: `grep: ${inputPath} is not a directory; use include to filter files`,
          };
        }
        searchRoot = access.resolved.abs;
      }
      const files = await fg(include, {
        cwd: searchRoot,
        dot: true,
        onlyFiles: true,
        followSymbolicLinks: false,
        ignore: ["**/node_modules/**", "**/.git/**"],
        absolute: true,
        suppressErrors: true,
      });
      const hits: string[] = [];
      let scanned = 0;
      for (const file of files.sort((a, b) => a.localeCompare(b))) {
        if (hits.length >= MAX_MATCHES) break;
        let content: string;
        try {
          if ((await stat(file)).size > MAX_FILE_BYTES) continue;
          content = await readFile(file, "utf8");
        } catch {
          continue;
        }
        if (content.includes("\u0000")) continue;
        scanned += 1;
        const rel = relative(ctx.cwd, file).split(sep).join("/");
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (hits.length >= MAX_MATCHES) break;
          const line = lines[i] ?? "";
          regex.lastIndex = 0;
          if (regex.test(line)) hits.push(`${rel}:${i + 1}: ${line.slice(0, 400)}`);
        }
      }
      if (hits.length === 0) {
        return { ok: true, output: `No matches for /${pattern}/ (${scanned} files scanned)` };
      }
      const capped =
        hits.length >= MAX_MATCHES ? `\n... [capped at ${MAX_MATCHES} matches] ...` : "";
      return {
        ok: true,
        output: hits.join("\n") + capped,
        summary: `${hits.length} match${hits.length === 1 ? "" : "es"} in ${scanned} files`,
      };
    } catch (error) {
      return invalidArguments(this.name, error);
    }
  }
}

export const grepTool = new GrepTool();
