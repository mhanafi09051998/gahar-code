import { join } from "node:path";
import {
  projectDir,
  projectFolderName,
  projectHash,
  projectSessionsDir,
  projectSlug,
  projectsDir,
  realCwd,
  sessionDir,
} from "../config/paths.js";

export interface ProjectPaths {
  cwd: string;
  folder: string;
  dir: string;
  sessionsDir: string;
}

export async function resolveProjectPaths(configDir: string, cwd: string): Promise<ProjectPaths> {
  const real = await realCwd(cwd);
  return {
    cwd: real,
    folder: projectFolderName(real),
    dir: projectDir(configDir, real),
    sessionsDir: projectSessionsDir(configDir, real),
  };
}

export function sessionPath(configDir: string, cwd: string, sessionId: string): string {
  return sessionDir(configDir, cwd, sessionId);
}

export function sessionMetaPath(dir: string): string {
  return join(dir, "meta.json");
}

export function sessionEventsPath(dir: string): string {
  return join(dir, "events.jsonl");
}

export function sessionSnapshotsDir(dir: string): string {
  return join(dir, "snapshots");
}

export { projectDir, projectFolderName, projectHash, projectSessionsDir, projectSlug, projectsDir };
