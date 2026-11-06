import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

/** Global config directory: GAHAR_CONFIG_DIR, else ~/.gahar. */
export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.GAHAR_CONFIG_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return resolve(fromEnv.trim());
  return join(homedir(), ".gahar");
}

export function globalConfigPath(configDir: string): string {
  return join(configDir, "config.json");
}

export function globalConfigBackupPath(configDir: string): string {
  return join(configDir, "config.json.bak");
}

export function cacheDir(configDir: string): string {
  return join(configDir, "cache");
}

export function projectsDir(configDir: string): string {
  return join(configDir, "projects");
}

/** Short stable hash of an absolute path (first 8 hex chars). */
export function projectHash(absPath: string, length = 8): string {
  return createHash("sha256").update(absPath).digest("hex").slice(0, length);
}

/** Filesystem-safe slug derived from the last path segment. */
export function projectSlug(absPath: string, maxLength = 32): string {
  const raw = basename(absPath) || absPath;
  const cleaned = raw
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase();
  if (cleaned.length === 0) return "project";
  return cleaned.slice(0, maxLength).replace(/[-.]+$/, "") || "project";
}

export function projectFolderName(absPath: string): string {
  return `${projectSlug(absPath)}-${projectHash(absPath)}`;
}

export function projectDir(configDir: string, absPath: string): string {
  return join(projectsDir(configDir), projectFolderName(absPath));
}

export function projectSessionsDir(configDir: string, absPath: string): string {
  return join(projectDir(configDir, absPath), "sessions");
}

export function sessionDir(configDir: string, absPath: string, sessionId: string): string {
  return join(projectSessionsDir(configDir, absPath), sessionId);
}

export function projectConfigPath(absPath: string): string {
  return join(absPath, ".gahar", "config.json");
}

export function resolveCwdWithin(rel: string, cwd: string): string {
  const abs = resolve(cwd, rel);
  const normalizedCwd = cwd.endsWith(sep) ? cwd : cwd + sep;
  return abs.startsWith(normalizedCwd) || abs === cwd ? abs : abs;
}

/** Resolves a path through realpath, falling back to the resolved path. */
export async function realCwd(input: string): Promise<string> {
  const absolute = resolve(input);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}
