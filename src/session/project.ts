import { join } from "node:path";
import {
  projectDir,
  projectFolderName,
  projectHash,
  projectSessionsDir,
  projectSlug,
  projectsDir,
  sessionDir,
} from "../config/paths.js";

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
