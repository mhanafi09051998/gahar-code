import type { PermissionMode } from "../contracts/config.js";
import type { ApprovalHandler, PermissionGate, PermissionRequest } from "../contracts/tools.js";
import { toErrorMessage } from "../shared/errors.js";

export interface PermissionGateOptions {
  mode: PermissionMode;
  handler?: ApprovalHandler | undefined;
  /** True when stdin/stdout can host an interactive prompt. */
  interactive?: boolean;
  /** Resource keys already allowed for the lifetime of this process. */
  allowlist?: Iterable<string>;
}

export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

export function resourceKey(request: PermissionRequest): string {
  return `${request.action}:${request.resource ?? request.title}`;
}

function isOutside(request: PermissionRequest): boolean {
  return request.action === "outside-workspace" || request.insideWorkspace === false;
}

/**
 * Pure mode matrix. Anything outside the workspace or on a protected path
 * always asks; full-auto allows the rest; auto-edit additionally allows writes
 * inside the workspace; shell and network ask until full-auto.
 */
export function autoAllowed(mode: PermissionMode, request: PermissionRequest): boolean {
  if (isOutside(request) || request.protectedPath === true) return false;
  if (mode === "full-auto") return true;
  return request.action === "write" && mode === "auto-edit";
}

function denyReason(request: PermissionRequest): string {
  const prefix = `${request.tool} requires ${request.action} approval, but no interactive prompt is available (non-interactive session).`;
  if (isOutside(request)) {
    return `${prefix} Paths outside the workspace always need interactive approval; run gahar from a directory that contains them.`;
  }
  if (request.protectedPath === true) {
    return `${prefix} Config, git metadata and hook files always need interactive approval.`;
  }
  const flag =
    request.action === "write" ? "--permission-mode auto-edit" : "--permission-mode full-auto";
  return `${prefix} Re-run with ${flag} or --yolo to allow it.`;
}

/**
 * The single place that understands permission modes. Read-only tools never
 * call it. Approval prompts are serialized so concurrent tools never stack
 * prompts, and "allow-session" decisions are remembered per resource key.
 */
export class DefaultPermissionGate implements PermissionGate {
  mode: PermissionMode;
  private readonly sessions = new Set<string>();
  private readonly handler: ApprovalHandler | undefined;
  private readonly interactive: boolean;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: PermissionGateOptions) {
    this.mode = options.mode;
    this.handler = options.handler;
    this.interactive = options.interactive ?? false;
    for (const key of options.allowlist ?? []) this.sessions.add(key);
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  isAllowedForSession(request: PermissionRequest): boolean {
    return this.sessions.has(resourceKey(request));
  }

  clearSession(): void {
    this.sessions.clear();
  }

  async ensure(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionDecision> {
    if (this.isAllowedForSession(request) || autoAllowed(this.mode, request)) {
      return { allowed: true };
    }
    if (!this.interactive || this.handler === undefined) {
      return { allowed: false, reason: denyReason(request) };
    }
    const handler = this.handler;
    const next = this.queue.then(() => this.prompt(handler, request, signal));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async prompt(
    handler: ApprovalHandler,
    request: PermissionRequest,
    signal: AbortSignal | undefined,
  ): Promise<PermissionDecision> {
    if (signal?.aborted === true) return { allowed: false, reason: "aborted before approval" };
    // An earlier queued prompt may already have granted this resource.
    if (this.isAllowedForSession(request)) return { allowed: true };
    try {
      const decision = await handler.request(request, signal);
      if (decision === "deny") {
        return {
          allowed: false,
          reason: `user denied ${request.action} for ${request.resource ?? request.title}`,
        };
      }
      if (decision === "allow-session") this.sessions.add(resourceKey(request));
      return { allowed: true };
    } catch (error) {
      return { allowed: false, reason: `approval handler failed: ${toErrorMessage(error)}` };
    }
  }
}

export function createPermissionGate(options: PermissionGateOptions): DefaultPermissionGate {
  return new DefaultPermissionGate(options);
}
