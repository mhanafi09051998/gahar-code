import type { PermissionMode } from "../contracts/config.js";
import type {
  ApprovalAction,
  ApprovalDecision,
  ApprovalHandler,
  PermissionGate,
  PermissionRequest,
} from "../contracts/tools.js";

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

export function isReadOnlyAction(action: ApprovalAction): boolean {
  return action !== "write" && action !== "shell" && action !== "outside-workspace";
}

/**
 * The single place that understands permission modes. Read-only tools never
 * ask, writes inside the workspace auto-allow in auto-edit, shell and network
 * always ask until full-auto, and anything outside the workspace always asks.
 */
export class DefaultPermissionGate implements PermissionGate {
  mode: PermissionMode;
  private readonly sessions = new Set<string>();
  private readonly handler: ApprovalHandler | undefined;
  private readonly interactive: boolean;

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

  allowForSession(request: PermissionRequest): void {
    this.sessions.add(resourceKey(request));
  }

  clearSession(): void {
    this.sessions.clear();
  }

  private autoAllowed(request: PermissionRequest): boolean {
    if (this.mode === "full-auto") return true;
    if (isReadOnlyAction(request.action)) return true;
    const inside = request.insideWorkspace !== false;
    if (request.action === "write" && inside && this.mode === "auto-edit") return true;
    return false;
  }

  private denyReason(request: PermissionRequest): string {
    const flag =
      request.action === "write" && request.insideWorkspace !== false
        ? "--permission-mode auto-edit"
        : "--permission-mode full-auto";
    return [
      `${request.tool} requires ${request.action} approval, but no interactive prompt is available`,
      `(non-interactive session). Re-run with ${flag} or --yolo to allow it.`,
    ].join(" ");
  }

  async ensure(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionDecision> {
    if (this.sessions.has(resourceKey(request)) || this.autoAllowed(request)) {
      return { allowed: true };
    }
    if (signal?.aborted === true) return { allowed: false, reason: "aborted before approval" };
    if (!this.interactive || this.handler === undefined) {
      return { allowed: false, reason: this.denyReason(request) };
    }
    let decision: ApprovalDecision;
    try {
      decision = await this.handler.request(request, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { allowed: false, reason: `approval handler failed: ${message}` };
    }
    if (decision === "allow-session") this.sessions.add(resourceKey(request));
    if (decision === "deny") {
      return {
        allowed: false,
        reason: `user denied ${request.action} for ${request.resource ?? request.title}`,
      };
    }
    return { allowed: true };
  }
}

export function createPermissionGate(options: PermissionGateOptions): DefaultPermissionGate {
  return new DefaultPermissionGate(options);
}
