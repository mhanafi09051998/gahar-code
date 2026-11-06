import { join } from "node:path";
import { truthy, type Writable } from "../cli/env.js";
import { BINARY_NAME } from "../shared/defaults.js";
import { atomicWriteFile, ensureDir, readTextFileIfExists } from "../shared/fsx.js";

export const UPDATE_NOTIFY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_WAIT_MS = 3000;

export interface UpdateCheckLike {
  latestVersion: string;
  updateAvailable: boolean;
}

export type UpdateChecker = (options: {
  timeoutMs?: number;
  configDir?: string;
}) => Promise<UpdateCheckLike | null>;

export interface UpdateNotifierOptions {
  stderr: Writable;
  configDir: string;
  enabled: boolean;
  env: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to the release teammate's checkForUpdate. */
  check?: UpdateChecker;
  now?: () => number;
  timeoutMs?: number;
}

export interface NotifyResult {
  checked: boolean;
  printed: boolean;
  line?: string;
}

export function notifyStatePath(configDir: string): string {
  return join(configDir, "cache", "update-notify.json");
}

export function formatUpdateLine(latestVersion: string): string {
  return `Update available: ${latestVersion} -> run: ${BINARY_NAME} update`;
}

/** True when a notice was already printed within the last 24h. */
export async function notifiedRecently(configDir: string, now: number): Promise<boolean> {
  try {
    const raw = await readTextFileIfExists(notifyStatePath(configDir));
    if (raw === null) return false;
    const parsed = JSON.parse(raw) as { notifiedAt?: unknown };
    return typeof parsed.notifiedAt === "number" && now - parsed.notifiedAt < UPDATE_NOTIFY_TTL_MS;
  } catch {
    return false;
  }
}

async function rememberNotified(configDir: string, now: number): Promise<void> {
  try {
    await ensureDir(join(configDir, "cache"));
    await atomicWriteFile(notifyStatePath(configDir), `${JSON.stringify({ notifiedAt: now })}\n`);
  } catch {
    // Best effort: worst case the notice repeats.
  }
}

async function loadUpdateCheck(): Promise<UpdateChecker | null> {
  try {
    const mod = (await import("../update/check.js")) as { checkForUpdate?: UpdateChecker };
    return typeof mod.checkForUpdate === "function" ? mod.checkForUpdate : null;
  } catch {
    return null;
  }
}

/**
 * Non-blocking update check. Never throws, never waits longer than 3s, and
 * prints at most one stderr line per 24h.
 */
export async function notifyUpdate(options: UpdateNotifierOptions): Promise<NotifyResult> {
  const now = (options.now ?? Date.now)();
  try {
    if (!options.enabled || truthy(options.env.GAHAR_NO_UPDATE_CHECK)) {
      return { checked: false, printed: false };
    }
    if (await notifiedRecently(options.configDir, now)) return { checked: false, printed: false };
    const check = options.check ?? (await loadUpdateCheck());
    if (check === null) return { checked: false, printed: false };
    const timeoutMs = Math.min(options.timeoutMs ?? MAX_WAIT_MS, MAX_WAIT_MS);
    const result = await withTimeout(check({ timeoutMs, configDir: options.configDir }), timeoutMs);
    if (result === null || !result.updateAvailable) return { checked: true, printed: false };
    const line = formatUpdateLine(result.latestVersion);
    options.stderr.write(`${line}\n`);
    await rememberNotified(options.configDir, now);
    return { checked: true, printed: true, line };
  } catch {
    return { checked: false, printed: false };
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
