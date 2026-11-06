import { createInterface } from "node:readline";
import type { Writable } from "../cli/env.js";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "../contracts/tools.js";
import { resourceKey } from "../security/permissions.js";

export interface ApprovalHandlerOptions {
  stderr: Writable;
  /** Interactive prompts are only used when this is true. */
  interactive: boolean;
  json?: boolean;
  /** Reads one answer line (the REPL passes its line editor); injectable for tests. */
  ask?: (question: string) => Promise<string>;
  /** Called before anything is printed, e.g. to stop a spinner. */
  beforePrompt?: () => void;
  /** Renders request detail (a diff or command); defaults to plain indented lines. */
  renderDetail?: (detail: string) => void;
  /** Remembered "always" decisions for the rest of the session. */
  sessionAllow?: Set<string>;
  onDecision?: (request: ApprovalRequest, decision: ApprovalDecision) => void;
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

function isUnsafeCodePoint(code: number, multiline: boolean): boolean {
  if (multiline && (code === 0x09 || code === 0x0a)) return false;
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Replaces terminal control characters (C0, C1, ESC, CR, bidi overrides) with
 * visible \xNN / \uNNNN escapes so model-supplied text cannot rewrite what the
 * user sees at an approval prompt. Multiline mode keeps tabs and newlines.
 */
export function neutralizeControls(text: string, multiline = false): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (!isUnsafeCodePoint(code, multiline)) out += char;
    else if (code <= 0xff) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return out;
}

function rawDetail(request: ApprovalRequest): string {
  return (request.detail ?? "").replace(/\r\n/g, "\n");
}

function hasControls(request: ApprovalRequest): boolean {
  const singleLine = [request.title, request.resource ?? ""];
  if (singleLine.some((text) => neutralizeControls(text) !== text)) return true;
  const detail = rawDetail(request);
  return neutralizeControls(detail, true) !== detail;
}

export function describeRequest(request: ApprovalRequest, includeDetail = true): string[] {
  const lines: string[] = [];
  lines.push(`${neutralizeControls(request.title)} (${request.action})`);
  if (request.resource) lines.push(`  resource: ${neutralizeControls(request.resource)}`);
  if (request.insideWorkspace === false) lines.push("  outside the workspace");
  if (request.protectedPath === true)
    lines.push("  protected path (config, git metadata or hooks)");
  if (hasControls(request)) {
    lines.push("  warning: contains terminal control characters, shown escaped as \\xNN");
  }
  const detail = neutralizeControls(rawDetail(request), true);
  if (includeDetail && detail !== "") {
    for (const line of detail.split("\n").slice(0, 60)) lines.push(`  ${line}`);
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
        options.beforePrompt?.();
        const custom = options.renderDetail !== undefined;
        for (const line of describeRequest(request, !custom)) options.stderr.write(`${line}\n`);
        if (custom && request.detail) {
          options.renderDetail?.(neutralizeControls(rawDetail(request), true));
        }
        const answer = await untilAborted(askQuestion(options, approvalQuestion()), signal);
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

/** Resolves to "" (deny) as soon as the turn is aborted. */
function untilAborted(answer: Promise<string>, signal?: AbortSignal): Promise<string> {
  if (signal === undefined) return answer;
  return new Promise<string>((resolve) => {
    const onAbort = (): void => resolve("");
    signal.addEventListener("abort", onAbort, { once: true });
    answer.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => resolve(""),
    );
  });
}

async function askQuestion(options: ApprovalHandlerOptions, question: string): Promise<string> {
  if (options.ask !== undefined) return options.ask(question);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer));
      rl.once("close", () => resolve(""));
    });
  } finally {
    rl.close();
  }
}
