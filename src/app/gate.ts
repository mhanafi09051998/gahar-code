import { toolDefinitions } from "../agent/index.js";
import { type ApprovalEvent, createEvent, type GaharEvent } from "../contracts/events.js";
import type {
  ApprovalRequest,
  PermissionGate,
  Tool,
  ToolContext,
  ToolRegistry,
} from "../contracts/tools.js";
import { isInsidePath, normalizePath } from "../security/paths.js";
import { redactSecrets } from "../security/redact.js";

function argString(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Maps a tool call to the approval it needs, or null when it may run without asking. */
export function approvalFor(tool: Tool, args: unknown, cwd: string): ApprovalRequest | null {
  const name = tool.name;
  if (name === "todo_write") return null;
  if (name === "run_command") {
    const command = argString(args, "command") ?? "";
    return { tool: name, action: "shell", title: `Run: ${command}`, resource: command };
  }
  if (name === "fetch_url") {
    const url = argString(args, "url") ?? "";
    return { tool: name, action: "network", title: `Fetch ${url}`, resource: url };
  }
  const input = argString(args, "path") ?? argString(args, "cwd");
  const abs = input === undefined ? cwd : normalizePath(input, cwd);
  const inside = isInsidePath(abs, cwd);
  if (!tool.readOnly) {
    return {
      tool: name,
      action: "write",
      title: `${name} ${input ?? abs}`,
      resource: abs,
      insideWorkspace: inside,
    };
  }
  if (inside) return null;
  return {
    tool: name,
    action: "outside-workspace",
    title: `${name} outside the workspace: ${abs}`,
    resource: abs,
    insideWorkspace: false,
  };
}

export interface GateDeps {
  gate: PermissionGate;
  cwd: string;
  secrets: string[];
  emit: (event: GaharEvent) => void;
}

/** Wraps a tool so it clears the permission gate first and never leaks secrets to the model. */
function gateTool(tool: Tool, deps: GateDeps): Tool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    readOnly: tool.readOnly,
    async execute(args: unknown, ctx: ToolContext) {
      const request = approvalFor(tool, args, deps.cwd);
      if (request !== null) {
        const decision = await deps.gate.ensure(request, ctx.signal);
        deps.emit(
          createEvent<ApprovalEvent>({
            type: "approval",
            tool: request.tool,
            action: request.action,
            decision: decision.allowed ? "allow" : "deny",
            ...(request.resource !== undefined ? { resource: request.resource } : {}),
          }),
        );
        if (!decision.allowed) {
          return { ok: false, output: `Permission denied: ${decision.reason ?? request.title}` };
        }
        // Snapshot before every in-workspace write, including new files, so undo can delete them.
        if (request.action === "write" && request.insideWorkspace && request.resource) {
          await ctx.snapshots.capture(request.resource);
        }
      }
      const result = await tool.execute(args, ctx);
      return { ...result, output: redactSecrets(result.output, deps.secrets) };
    },
  };
}

export function createRegistry(tools: readonly Tool[], deps: GateDeps): ToolRegistry {
  const gated = tools.map((tool) => gateTool(tool, deps));
  return {
    list: () => [...gated],
    get: (name) => gated.find((tool) => tool.name === name),
    definitions: () => toolDefinitions(gated),
  };
}
