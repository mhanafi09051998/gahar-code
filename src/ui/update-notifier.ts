import { readFile } from "node:fs/promises";
import { APP_NAME } from "../shared/defaults.js";
import { VERSION } from "../shared/version.js";
import { truthy, type Writable } from "../cli/env.js";

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCheckLike {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
}

export interface UpdateNotifierOptions {
  stderr: Writable;
  configDir: string;
  enabled: boolean;
  env: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to the real release checker. */
  check?: (options: { timeoutMs?: number }) => Promise<UpdateCheckLike | null>;
  now?: () => number;
  timeoutMs?: number;
  version?: string;
}

interface CacheShape {
  checkedAt: number;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
}

export interface NotifyResult {
  checked: boolean;
  printed: boolean;
  line?: string;
}

export function updateCachePath(configDir: string): string {
  return `${configDir.replace(/[\\/]$/, "")}/cache/update-notify.json`;
}

export function shouldCheck(options: UpdateNotifierOptions, now: number): boolean {
  if (!options.enabled) return false;
  if (truthy(options.env.GAHAR_NO_UPDATE_CHECK)) return false;
  void now;
  return true;
}

export function formatUpdateLine(latestVersion: string): string {
  return `Update available: ${VERSION} -> ${latestVersion} -> run: gahar update`;
}

/** Reads the cached check result; returns null when it is missing, stale or corrupt. */
export async function readCache(configDir: string, now: number): Promise<CacheShape | null> {
  try {
    const raw = await readFile(updateCachePath(configDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const cache = parsed as Partial<CacheShape>;
    if (
      typeof cache.checkedAt !== "number" ||
      typeof cache.latestVersion !== "string" ||
      typeof cache.releaseUrl !== "string"
    ) {
      return null;
    }
    if (now - cache.checkedAt > UPDATE_CHECK_TTL_MS) return null;
    return {
      checkedAt: cache.checkedAt,
      latestVersion: cache.latestVersion,
      updateAvailable: cache.updateAvailable === true,
      releaseUrl: cache.releaseUrl,
    };
  } catch {
    return null;
  }
}

export async function loadUpdateCheck(): Promise<
  ((options: { timeoutMs?: number }) => Promise<UpdateCheckLike | null>) | null
> {
  try {
    const mod = (await import("../update/check.js")) as {
      checkForUpdate?: (options?: { timeoutMs?: number }) => Promise<UpdateCheckLike | null>;
    };
    if (typeof mod.checkForUpdate !== "function") return null;
    return mod.checkForUpdate;
  } catch {
    return null;
  }
}

/**
 * Non-blocking update check. Never throws, never delays startup beyond the
 * timeout, and prints at most one stderr line per 24h.
 */
export async function notifyUpdate(options: UpdateNotifierOptions): Promise<NotifyResult> {
  const now = (options.now ?? Date.now)();
  try {
    if (!shouldCheck(options, now)) return { checked: false, printed: false };
    const cache = await readCache(options.configDir, now);
    if (cache !== null && cache.updateAvailable) {
      const line = formatUpdateLine(cache.latestVersion);
      options.stderr.write(`${line}\n`);
      return { checked: false, printed: true, line };
    }
    if (cache !== null) return { checked: false, printed: false };
    const check = options.check ?? (await loadUpdateCheck());
    if (check === null) return { checked: false, printed: false };
    const result = await withTimeout(check({ timeoutMs: options.timeoutMs ?? 3000 }), 3000);
    if (result === null || result.updateAvailable !== true) return { checked: true, printed: false };
    const line = formatUpdateLine(result.latestVersion);
    options.stderr.write(`${line}\n`);
    return { checked: true, printed: true, line };
  } catch {
    return { checked: false, printed: false };
  }
}

export function bannerTitle(): string {
  return `${APP_NAME} ${VERSION}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
