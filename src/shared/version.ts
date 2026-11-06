import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const packagePath = resolve(here, "../../package.json");
    const parsed: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === "string" && version.length > 0) return version;
    }
  } catch {
    // Fall through to a safe development version.
  }
  return "0.0.0";
}

export const VERSION = readVersion();
