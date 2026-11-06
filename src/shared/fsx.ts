import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Owner-only modes for transcripts, snapshots and other private state. */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Creates a directory tree; `mode` applies to directories created by this call. */
export async function ensureDir(dir: string, mode?: number): Promise<void> {
  await mkdir(dir, mode === undefined ? { recursive: true } : { recursive: true, mode });
}

/** Best-effort chmod: Windows and some filesystems do not support POSIX modes. */
export async function chmodBestEffort(filePath: string, mode: number): Promise<void> {
  try {
    await chmod(filePath, mode);
  } catch {
    // Mode bits are advisory where unsupported.
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readTextFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

export async function atomicWriteFile(
  filePath: string,
  content: string,
  options: { mode?: number } = {},
): Promise<void> {
  await ensureDir(dirname(filePath));
  const tempPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  await writeFile(tempPath, content, { encoding: "utf8", mode: options.mode ?? 0o644 });
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function sha256(text: string | Buffer): Promise<string> {
  return createHash("sha256").update(text).digest("hex");
}

export function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export async function removePath(filePath: string): Promise<void> {
  await rm(filePath, { recursive: true, force: true });
}
