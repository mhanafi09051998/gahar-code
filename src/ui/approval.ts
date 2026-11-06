import { createInterface } from "node:readline";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "../contracts/tools.js";
import type { Writable } from "../cli/env.js";

export interface ApprovalHandlerOptions {
  stderr: Writable;
  /** Interactive prompts are only used when this is true. */
  interactive: boolean;
  json?: boolean;
  /** Reads one answer line; injectable for tests. */
  ask?: (question: string) => Promise<string>;
  /** Remembered "always" decisions for the rest of the session. */
  sessionAllow?: Set<string>;
  onDecision?: (request: ApprovalRequest, decision: ApprovalDecision) => void;
}

export interface DenialHint {
  reason: string;
  hint: string;
}

/** Builds the "[y]es / [a]lways / [n]o" question text. */
export function approvalQuestion(): string {
  return "Approve? [y]es / [a]lways (session) / [n]o (default: no) ";
}

export function parseAnswer(answer: string): ApprovalDecision {
  const normalized = answer.trim().toLowerCase();
  if (normalized === "y" || normalized === "yes") return "allow";
  if (normalized === "a" || normalized === "always" || normalized === "all") return "allow-session";
  return "deny";
}

export function resourceKey(request: ApprovalRequest): string {
  return `${request.tool}:${request.action}:${request.resource ?? request.title}`;
}

export function describeRequest(request: ApprovalRequest): string[] {
  const lines: string[] = [];
  lines.push(`${request.title} (${request.action})`);
  if (request.resource) lines.push(`  resource: ${request.resource}`);
  if (request.insideWorkspace === false) lines.push("  outside the workspace");
  if (request.detail !== undefined && request.detail !== "") {
    for (const line of request.detail.replace(/\r\n/g, "\n").split("\n").slice(0, 60)) {
      lines.push(`  ${line}`);
    }
  }
  return lines;
}

export function createApprovalHandler(options: ApprovalHandlerOptions): ApprovalHandler {
  const sessionAllow = options.sessionAllow ?? new Set<string>();
  return {
    async request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
      try {
        if (signal?.aborted) return "deny";
        if (!options.interactive || options.json === true) return "deny";
        const key = resourceKey(request);
        if (sessionAllow.has(key)) {
          options.onDecision?.(request, "allow-session");
          return "allow-session";
        }
        for (const line of describeRequest(request)) options.stderr.write(`${line}\n`);
        const answer = await askQuestion(options, approvalQuestion());
        if (signal?.aborted) return "deny";
        const decision = parseAnswer(answer);
        if (decision === "allow-session") sessionAllow.add(key);
        options.onDecision?.(request, decision);
        return decision;
      } catch {
        return "deny";
      }
    },
  };
}

/** Non-interactive handler: never prints, never hangs, always denies. */
export function createDenyAllHandler(
  onDecision?: (request: ApprovalRequest, decision: ApprovalDecision) => void,
): ApprovalHandler {
  return {
    async request(request: ApprovalRequest): Promise<ApprovalDecision> {
      onDecision?.(request, "deny");
      return "deny";
    },
  };
}

async function askQuestion(options: ApprovalHandlerOptions, question: string): Promise<string> {
  if (options.ask !== undefined) return options.ask(question);
  const rl = createInterface({ input: process.stdin, output: options.stderr as NodeJS.WritableStream });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer));
      rl.once("close", () => resolve(""));
    });
  } finally {
    rl.close();
  }
}
