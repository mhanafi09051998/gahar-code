import { APP_NAME } from "../shared/defaults.js";
import { VERSION } from "../shared/version.js";
import type { Writable } from "../cli/env.js";

export interface BannerOptions {
  stderr: Writable;
  version?: string;
  model: string;
  cwd: string;
  permissionMode: string;
  sessionId?: string;
  resumed?: boolean;
  quiet?: boolean;
  color?: boolean;
  columns?: number;
}

export function createBanner(options: BannerOptions): string[] {
  const version = options.version ?? VERSION;
  const short = shortenPath(options.cwd, Math.max(20, (options.columns ?? 80) - 16));
  const lines = [
    `${APP_NAME} ${version}`,
    `  model      ${options.model}`,
    `  directory  ${short}`,
    `  permission ${options.permissionMode}`,
  ];
  if (options.resumed === true && options.sessionId !== undefined) {
    lines.push(`  session    ${options.sessionId} (resumed)`);
  }
  lines.push("", "Type /help for commands, Ctrl+C to cancel, Ctrl+D to exit.");
  return lines;
}

export function renderBanner(options: BannerOptions): void {
  if (options.quiet === true) return;
  options.stderr.write(`${createBanner(options).join("\n")}\n`);
}

export function shortenPath(cwd: string, maxLength: number): string {
  if (cwd.length <= maxLength) return cwd;
  const parts = cwd.split(/[\\/]/).filter((part) => part !== "");
  let result = parts[parts.length - 1] ?? cwd;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    const candidate = `...${"/"}${parts.slice(index).join("/")}`;
    if (candidate.length > maxLength) break;
    result = candidate;
  }
  return result.length <= maxLength ? result : `...${result.slice(-(maxLength - 3))}`;
}
