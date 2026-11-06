import type { ToolDefinition } from "../contracts/messages.js";
import type { Tool, ToolRegistry } from "../contracts/tools.js";
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

export class DefaultToolRegistry implements ToolRegistry {
  private readonly tools: readonly Tool[];
  private readonly byName: ReadonlyMap<string, Tool>;

  constructor(tools: readonly Tool[]) {
    const byName = new Map<string, Tool>();
    for (const tool of tools) {
      if (byName.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
      byName.set(tool.name, tool);
    }
    this.tools = [...tools];
    this.byName = byName;
  }

  list(): Tool[] {
    return [...this.tools];
  }

  get(name: string): Tool | undefined {
    return this.byName.get(name);
  }

  definitions(): ToolDefinition[] {
    return this.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
}

export function createDefaultRegistry(tools: readonly Tool[] = builtinTools): DefaultToolRegistry {
  return new DefaultToolRegistry(tools);
}
