import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedConfig } from "../contracts/config.js";
import type { ChatClient } from "../contracts/messages.js";
import { ensureDir, removePath } from "../shared/fsx.js";
import { checkForUpdate } from "../update/check.js";
import type { DoctorProbes } from "./doctor.js";

const PROBE_TIMEOUT_MS = 5000;

const VERSION_ARGS: Record<string, string[]> = {
  pwsh: ["-NoProfile", "-Command", "exit 0"],
  powershell: ["-NoProfile", "-Command", "exit 0"],
};

export function commandAvailable(command: string): boolean {
  const result = spawnSync(command, VERSION_ARGS[command] ?? ["--version"], {
    stdio: "ignore",
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  return result.error === undefined && result.status === 0;
}

/** Real probes backed by the filesystem, OpenRouter and GitHub. */
export function createDoctorProbes(
  config: ResolvedConfig,
  client: Pick<ChatClient, "validateKey" | "listModels">,
  fetchImpl: typeof fetch = fetch,
): DoctorProbes {
  return {
    nodeVersion: process.version,
    configDir: config.configDir,
    apiKey: config.apiKey,
    model: config.model,
    async checkConfigDirWritable() {
      await ensureDir(config.configDir);
      const probe = join(config.configDir, `.doctor-${process.pid}.tmp`);
      await writeFile(probe, "ok", "utf8");
      await removePath(probe);
    },
    async networkReachable() {
      const response = await fetchImpl(`${config.baseUrl}/models`, {
        method: "HEAD",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return response.status > 0;
    },
    validateKey: (key) => client.validateKey(key),
    async modelExists(model) {
      const catalog = await client.listModels();
      return catalog.some((item) => item.id === model);
    },
    commandAvailable: async (command) => commandAvailable(command),
    installLocation: () => resolve(fileURLToPath(import.meta.url), "..", "..", ".."),
    async latestVersion() {
      const result = await checkForUpdate({
        configDir: config.configDir,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      if (result === null) return null;
      return {
        current: result.currentVersion,
        latest: result.latestVersion,
        newer: result.updateAvailable,
      };
    },
  };
}
