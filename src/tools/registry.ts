import type { JsonSchema } from "../contracts/messages.js";
import type { Tool, ToolContext, ToolResult } from "../contracts/tools.js";

import { editFileTool } from "./edit_file.js";
import { fetchUrlTool } from "./fetch_url.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { listDirTool } from "./list_dir.js";
import { multiEditTool } from "./multi_edit.js";
import { readFileTool } from "./read_file.js";
import { runCommandTool } from "./run_command.js";
import { todoWriteTool } from "./todo_write.js";
import { webSearchTool } from "./web_search.js";
import { writeFileTool } from "./write_file.js";

/** Every built-in tool, in the order they are advertised to the model. */
export const builtinTools: readonly Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  multiEditTool,
  listDirTool,
  globTool,
  grepTool,
  runCommandTool,
  fetchUrlTool,
  webSearchTool,
  todoWriteTool,
];

export function toolByName(tools: readonly Tool[], name: string): Tool | undefined {
  return tools.find((tool) => tool.name === name);
}

export function findTool(name: string): Tool | undefined {
  return toolByName(builtinTools, name);
}

export interface ToolSummary {
  name: string;
  description: string;
  readOnly: boolean;
}

export function listTools(tools: readonly Tool[] = builtinTools): ToolSummary[] {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, readOnly: tool.readOnly }));
}

/** Execute a tool by name, returning a failed result when the name is unknown. */
export async function executeTool(
  name: string,
  args: unknown,
  ctx: ToolContext,
  tools: readonly Tool[] = builtinTools,
): Promise<ToolResult> {
  const tool = toolByName(tools, name);
  if (!tool) {
    const known = tools.map((candidate) => candidate.name).join(", ");
    return { ok: false, output: `Unknown tool "${name}". Available tools: ${known}` };
  }
  if (tool.readOnly !== true) {
    // Writes require the permission gate; callers must check before executing.
    const decision = await ctx.permissions.check({ kind: "tool", tool: name, args });
    if (decision === "deny") {
      return { ok: false, output: `Permission denied for tool "${name}".` };
    }
  }
  try {
    return await tool.execute(args, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, output: `${name} failed: ${message}` };
  }
}

export type { JsonSchema };

export {
  editFileTool,
  fetchUrlTool,
  globTool,
  grepTool,
  listDirTool,
  multiEditTool,
  readFileTool,
  runCommandTool,
  todoWriteTool,
  webSearchTool,
  writeFileTool,
};
