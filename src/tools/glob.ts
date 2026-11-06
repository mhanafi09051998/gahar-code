import { isAbsolute, relative, sep } from "node:path";

import fg from "fast-glob";

import type { JsonSchema } from "../contracts/messages.js";
import type { Tool, ToolContext, ToolResult } from "../contracts/tools.js";
import { truncateLines } from "../shared/truncate.js";
import { resolveReadable } from "./access.js";
import {
  asRecord,
  invalidArguments,
  optionalString,
  requireContainedPattern,
  requireString,
} from "./args.js";
import { objectSchema, stringProperty } from "./schema.js";

const MAX_RESULTS = 200;

export class GlobTool implements Tool {
  readonly name = "glob";
  readonly description =
    "Find files by glob pattern (for example src/**/*.ts). Respects .gitignore and skips node_modules unless the pattern names it.";
  readonly readOnly = true;
  readonly parameters: JsonSchema = objectSchema(
    {
      pattern: stringProperty('Glob pattern, for example "src/**/*.ts".'),
      cwd: stringProperty(
        "Directory to search from, relative to the workspace. Defaults to the workspace root.",
      ),
    },
    ["pattern"],
  );

  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const args = asRecord(rawArgs, this.name);
      const pattern = requireContainedPattern(requireString(args, "pattern"), "pattern");
      const inputCwd = optionalString(args, "cwd");
      let searchRoot = ctx.cwd;
      if (inputCwd !== undefined) {
        const access = await resolveReadable(ctx, this.name, inputCwd);
        if (access.denied) return access.denied;
        if (access.resolved.type !== "directory") {
          return { ok: false, output: `glob: ${inputCwd} is not a directory` };
        }
        searchRoot = access.resolved.abs;
      }
      const wantsModules = pattern.includes("node_modules");
      const matches = await fg(pattern, {
        cwd: searchRoot,
        dot: true,
        onlyFiles: true,
        followSymbolicLinks: false,
        ignore: wantsModules ? ["**/.git/**"] : ["**/.git/**", "**/node_modules/**"],
        absolute: true,
        suppressErrors: true,
      });
      if (matches.length === 0) {
        return { ok: true, output: `No files matched "${pattern}"`, summary: "0 matches" };
      }
      const sorted = matches.sort((a, b) => a.localeCompare(b));
      const limited = sorted.slice(0, MAX_RESULTS);
      const lines = limited.map((abs) => {
        const rel = relative(ctx.cwd, abs).split(sep).join("/");
        return isAbsolute(rel) ? abs : rel;
      });
      const more =
        sorted.length > MAX_RESULTS
          ? `\n... [${sorted.length - MAX_RESULTS} more matches; narrow the pattern] ...`
          : "";
      return {
        ok: true,
        output: `${truncateLines(lines.join("\n"), MAX_RESULTS).text}${more}`,
        summary: `${limited.length} match${limited.length === 1 ? "" : "es"}`,
      };
    } catch (error) {
      return invalidArguments(this.name, error);
    }
  }
}

export const globTool = new GlobTool();
