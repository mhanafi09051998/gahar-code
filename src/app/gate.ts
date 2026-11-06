import { type ApprovalEvent, createEvent, type GaharEvent } from "../contracts/events.js";
import type { PermissionGate, Tool, ToolContext } from "../contracts/tools.js";
import { redactSecrets } from "../security/redact.js";

/** Reports every permission decision as an approval event without changing the decision. */
export function observeGate(
  gate: PermissionGate,
  emit: (event: GaharEvent) => void,
): PermissionGate {
  return {
    async ensure(request, signal) {
      const decision = await gate.ensure(request, signal);
      emit(
        createEvent<ApprovalEvent>({
          type: "approval",
          tool: request.tool,
          action: request.action,
          decision: decision.allowed ? "allow" : "deny",
          ...(request.resource !== undefined ? { resource: request.resource } : {}),
        }),
      );
      return decision;
    },
  };
}

/** Wraps tools so their output never carries the given secrets back to the model or the UI. */
export function redactToolOutput(tools: readonly Tool[], secrets: readonly string[]): Tool[] {
  return tools.map((tool) => ({
    ...tool,
    async execute(args: unknown, ctx: ToolContext) {
      const result = await tool.execute(args, ctx);
      return { ...result, output: redactSecrets(result.output, secrets) };
    },
  }));
}
