import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
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

export async function fileSize(filePath: string): Promise<number> {
  const info = await stat(filePath);
  return info.size;
}

export async function isProbablyBinary(filePath: string): Promise<boolean> {
  try {
    const handle = await readFile(filePath);
    const sample = handle.subarray(0, 8192);
    for (const byte of sample) {
      if (byte === 0) return true;
    }
    return false;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
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
